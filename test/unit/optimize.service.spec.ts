import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { InfeasibleScheduleError, InterpreterError } from '../../src/common/errors';
import { OptimizeRequestDto } from '../../src/optimize/dto/optimize-request.dto';
import { FallbackInterpreterService } from '../../src/optimize/fallback-interpreter.service';
import { GuardrailsService } from '../../src/optimize/guardrails.service';
import { InterpreterService } from '../../src/optimize/interpreter.service';
import { OptimizeService } from '../../src/optimize/optimize.service';
import { OptimizerService } from '../../src/optimize/optimizer.service';
import { VerifierService } from '../../src/optimize/verifier.service';

const pack = JSON.parse(
  readFileSync(resolve(__dirname, '../../sample-cases/public-sample-cases.json'), 'utf8'),
);

const sample = (index: number): OptimizeRequestDto =>
  JSON.parse(JSON.stringify(pack.cases[index].input));

function build(interpretStub: Partial<InterpreterService>) {
  const fallback = new FallbackInterpreterService();
  const guardrails = new GuardrailsService();
  const optimizer = new OptimizerService();
  const verifier = new VerifierService();
  const service = new OptimizeService(
    interpretStub as InterpreterService,
    fallback,
    guardrails,
    optimizer,
    verifier,
  );
  for (const target of [service, fallback, guardrails, optimizer] as any[]) {
    jest.spyOn(target['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(target['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(target['logger'], 'error').mockImplementation(() => undefined);
  }
  return { service, verifier, optimizer };
}

/** An interpreter stub that returns the published ground truth for a sample case. */
function groundTruthInterpreter(index: number): Partial<InterpreterService> {
  return {
    interpret: jest.fn().mockResolvedValue({
      directives: JSON.parse(
        JSON.stringify(pack.cases[index].expected_output.directive_interpretation),
      ),
      source: 'llm',
    }),
  };
}

describe('OptimizeService (pipeline)', () => {
  it('produces a complete, schema-correct response', async () => {
    const { service } = build(groundTruthInterpreter(0));
    const request = sample(0);
    const response = await service.optimizeEnergy(request);

    expect(response.scenario_id).toBe(request.scenario_id);
    expect(response.hourly_plan).toHaveLength(24);
    expect(response.directive_interpretation).toHaveLength(request.operator_notes.length);
    expect(typeof response.plan_summary).toBe('string');
    expect(response.plan_summary.length).toBeGreaterThan(20);
    for (const entry of response.hourly_plan) {
      expect(Object.keys(entry).sort()).toEqual([
        'battery_action',
        'battery_energy_after_kwh',
        'battery_kwh',
        'grid_kwh',
        'hour',
        'solar_used_kwh',
      ]);
    }
  });

  it('recalculates the totals from hourly_plan', async () => {
    const { service } = build(groundTruthInterpreter(4));
    const request = sample(4);
    const response = await service.optimizeEnergy(request);

    const tariff = new Map(request.hours.map((h) => [h.hour, h.tariff_bdt_per_kwh]));
    const grid = response.hourly_plan.reduce((sum, e) => sum + e.grid_kwh, 0);
    const cost = response.hourly_plan.reduce((sum, e) => sum + e.grid_kwh * tariff.get(e.hour)!, 0);
    const peak = Math.max(...response.hourly_plan.map((e) => e.grid_kwh));

    expect(response.total_grid_kwh).toBeCloseTo(grid, 2);
    expect(response.total_cost_bdt).toBeCloseTo(cost, 2);
    expect(response.peak_grid_kwh).toBeCloseTo(peak, 2);
  });

  it('matches the published reference cost on every public case', async () => {
    for (let index = 0; index < pack.cases.length; index += 1) {
      const { service } = build(groundTruthInterpreter(index));
      const response = await service.optimizeEnergy(sample(index));
      expect(response.total_cost_bdt).toBeLessThanOrEqual(
        pack.cases[index].expected_output.total_cost_bdt + 0.01,
      );
    }
  });

  it('falls back to the deterministic interpreter when the model is unavailable', async () => {
    const { service } = build({
      interpret: jest.fn().mockRejectedValue(new InterpreterError('provider down')),
    });
    const response = await service.optimizeEnergy(sample(1));
    expect(response.directive_interpretation[0].directive_type).toBe('no_charge_window');
    expect(response.hourly_plan).toHaveLength(24);
  });

  it('falls back when the model output cannot pass guardrails', async () => {
    const { service } = build({
      interpret: jest.fn().mockResolvedValue({
        directives: [{ note_index: 0, directive_type: 'shed_load', structured_adjustment: {} }],
        source: 'llm',
      }),
    });
    const response = await service.optimizeEnergy(sample(1));
    expect(response.directive_interpretation[0].directive_type).toBe('no_charge_window');
  });

  it('never returns a directive type outside the supported six', async () => {
    const { service } = build({
      interpret: jest.fn().mockResolvedValue({
        directives: [
          {
            note_index: 0,
            applies: true,
            directive_type: 'no_charge_window',
            structured_adjustment: { hours: [4, 2, 3, 2] },
            explanation: 'x',
          },
        ],
        source: 'llm',
      }),
    });
    const response = await service.optimizeEnergy(sample(1));
    expect(response.directive_interpretation[0].directive_type).toBe('no_charge_window');
    expect((response.directive_interpretation[0].structured_adjustment as any).hours).toEqual([2, 3, 4]);
  });

  it('applies the directive it reports, verified by replay', async () => {
    const { service, verifier, optimizer } = build(groundTruthInterpreter(2));
    const request = sample(2);
    const response = await service.optimizeEnergy(request);

    const constraints = optimizer.buildConstraintModel(
      request.hours,
      request.battery,
      response.directive_interpretation,
    );
    const check = verifier.verify(response.hourly_plan, request.hours, request.battery, constraints);
    expect(check.violations).toEqual([]);
  });

  it('throws InfeasibleScheduleError when no valid schedule exists', async () => {
    const request = sample(0);
    const { service } = build({
      interpret: jest.fn().mockResolvedValue({
        directives: [
          {
            note_index: 0,
            applies: true,
            directive_type: 'minimum_battery_reserve',
            structured_adjustment: { hours: [1], minimum_energy_kwh: request.battery.capacity_kwh },
            explanation: 'x',
          },
          {
            note_index: 1,
            applies: true,
            directive_type: 'no_charge_window',
            structured_adjustment: { hours: [...Array(24).keys()] },
            explanation: 'x',
          },
        ],
        source: 'llm',
      }),
    });
    await expect(service.optimizeEnergy(request)).rejects.toBeInstanceOf(InfeasibleScheduleError);
  });

  it('returns a valid passive schedule when the optimized one cannot be verified', async () => {
    const { service, optimizer } = build(groundTruthInterpreter(0));
    // Force the optimizer to hand back an unusable plan.
    jest.spyOn(optimizer, 'optimize').mockImplementation((hours, battery, directives) => ({
      constraints: optimizer.buildConstraintModel(hours, battery, directives),
      plan: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        grid_kwh: -1,
        solar_used_kwh: 0,
        battery_action: 'idle' as const,
        battery_kwh: 0,
        battery_energy_after_kwh: battery.initial_energy_kwh,
      })),
    }));

    const response = await service.optimizeEnergy(sample(0));
    expect(response.hourly_plan.every((entry) => entry.grid_kwh >= 0)).toBe(true);
    expect(response.hourly_plan.every((entry) => entry.battery_action === 'idle')).toBe(true);
  });

  it('describes applied and ignored notes in the summary', async () => {
    const { service } = build(groundTruthInterpreter(5));
    const response = await service.optimizeEnergy(sample(5));
    expect(response.plan_summary).toMatch(/solar reduction/i);
    expect(response.plan_summary).toMatch(/no-charge window/i);
    expect(response.plan_summary).toMatch(/no_op/i);
  });
});
