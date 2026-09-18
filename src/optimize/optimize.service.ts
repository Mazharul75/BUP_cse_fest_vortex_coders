import { Injectable, Logger } from '@nestjs/common';
import { InfeasibleScheduleError } from '../common/errors';
import { HOURS_IN_DAY, roundTo } from './constants';
import { OptimizeRequestDto } from './dto/optimize-request.dto';
import {
  DirectiveInterpretation,
  HourlyPlanEntry,
  OptimizeResponse,
} from './dto/optimize-response.dto';
import { FallbackInterpreterService } from './fallback-interpreter.service';
import { GuardrailsService } from './guardrails.service';
import { InterpreterService } from './interpreter.service';
import { ConstraintModel, OptimizerService } from './optimizer.service';
import { VerifierService } from './verifier.service';

/**
 * Pipeline orchestration:
 *   operator notes -> LLM interpretation -> deterministic guardrails
 *                  -> LP optimization -> replay verification -> response
 */
@Injectable()
export class OptimizeService {
  private readonly logger = new Logger(OptimizeService.name);

  constructor(
    private readonly interpreter: InterpreterService,
    private readonly fallbackInterpreter: FallbackInterpreterService,
    private readonly guardrails: GuardrailsService,
    private readonly optimizer: OptimizerService,
    private readonly verifier: VerifierService,
  ) {}

  async optimizeEnergy(request: OptimizeRequestDto): Promise<OptimizeResponse> {
    const directives = await this.resolveDirectives(request);

    const { plan, constraints } = this.produceSchedule(request, directives);

    const totalGridKwh = plan.reduce((sum, entry) => sum + entry.grid_kwh, 0);
    const tariffByHour = new Map(
      request.hours.map((entry) => [entry.hour, entry.tariff_bdt_per_kwh]),
    );
    const totalCostBdt = plan.reduce(
      (sum, entry) => sum + entry.grid_kwh * (tariffByHour.get(entry.hour) ?? 0),
      0,
    );
    const peakGridKwh = plan.reduce((peak, entry) => Math.max(peak, entry.grid_kwh), 0);

    return {
      scenario_id: request.scenario_id,
      directive_interpretation: directives,
      hourly_plan: plan,
      // Recalculated from hourly_plan, which is the single source of truth.
      total_grid_kwh: roundTo(totalGridKwh),
      total_cost_bdt: roundTo(totalCostBdt),
      peak_grid_kwh: roundTo(peakGridKwh),
      plan_summary: this.buildSummary(directives, plan, constraints, totalCostBdt, peakGridKwh),
    };
  }

  // ----------------------------------------------------------- interpretation ---

  private async resolveDirectives(
    request: OptimizeRequestDto,
  ): Promise<DirectiveInterpretation[]> {
    try {
      const result = await this.interpreter.interpret(request.operator_notes, request.battery);
      const validated = this.guardrails.validateDirectives(
        result.directives,
        request.operator_notes,
        request.battery,
      );
      this.logger.log(
        `Interpreted ${validated.length} note(s) for ${request.scenario_id} via ${result.source}`,
      );
      return validated;
    } catch (error) {
      // Any failure in the model path - transport error, timeout, malformed output,
      // guardrail rejection, or an unexpected SDK exception - degrades to the
      // deterministic interpreter rather than failing the request.
      const name = error instanceof Error ? error.name : 'UnknownError';
      this.logger.warn(
        `Model interpretation unusable for ${request.scenario_id} (${name}); using failure-path interpreter`,
      );
      const fallback = this.fallbackInterpreter.interpret(request.operator_notes, request.battery);
      // The fallback output is held to exactly the same guardrails.
      return this.guardrails.validateDirectives(
        fallback,
        request.operator_notes,
        request.battery,
      );
    }
  }

  // -------------------------------------------------------------- scheduling ---

  private produceSchedule(
    request: OptimizeRequestDto,
    directives: DirectiveInterpretation[],
  ): { plan: HourlyPlanEntry[]; constraints: ConstraintModel } {
    let constraints: ConstraintModel | null = null;

    try {
      const optimized = this.optimizer.optimize(request.hours, request.battery, directives);
      constraints = optimized.constraints;

      const verification = this.verifier.verify(
        optimized.plan,
        request.hours,
        request.battery,
        optimized.constraints,
      );
      if (verification.valid) {
        return optimized;
      }
      this.logger.error(
        `Replay verification failed for ${request.scenario_id}: ${verification.violations.join('; ')}`,
      );
    } catch (error) {
      if (!(error instanceof InfeasibleScheduleError)) throw error;
      this.logger.warn(`LP reported infeasibility for ${request.scenario_id}`);
      constraints = this.optimizer.buildConstraintModel(
        request.hours,
        request.battery,
        directives,
      );
    }

    // Last-resort schedule: meet demand from effective solar plus grid, leave the
    // battery untouched. Validity outranks cost, so a verified passive plan is
    // returned in preference to an unverifiable optimized one.
    const passive = this.buildPassivePlan(request, constraints!);
    const passiveCheck = this.verifier.verify(
      passive,
      request.hours,
      request.battery,
      constraints!,
    );
    if (passiveCheck.valid) {
      this.logger.warn(`Returning the passive fallback schedule for ${request.scenario_id}`);
      return { plan: passive, constraints: constraints! };
    }

    throw new InfeasibleScheduleError();
  }

  private buildPassivePlan(
    request: OptimizeRequestDto,
    constraints: ConstraintModel,
  ): HourlyPlanEntry[] {
    const byHour = new Map(request.hours.map((entry) => [entry.hour, entry]));
    const plan: HourlyPlanEntry[] = [];

    for (let h = 0; h < HOURS_IN_DAY; h += 1) {
      const demand = byHour.get(h)!.demand_kwh;
      const solarUsed = roundTo(Math.min(constraints.effectiveSolar[h], demand));
      plan.push({
        hour: h,
        grid_kwh: roundTo(Math.max(0, demand - solarUsed)),
        solar_used_kwh: solarUsed,
        battery_action: 'idle',
        battery_kwh: 0,
        battery_energy_after_kwh: roundTo(request.battery.initial_energy_kwh),
      });
    }

    return plan;
  }

  // ----------------------------------------------------------------- summary ---

  private buildSummary(
    directives: DirectiveInterpretation[],
    plan: HourlyPlanEntry[],
    constraints: ConstraintModel,
    totalCost: number,
    peakGrid: number,
  ): string {
    const applied = directives.filter((directive) => directive.applies);
    const ignored = directives.length - applied.length;

    const parts: string[] = [];

    if (applied.length === 0) {
      parts.push('No operator directive changed the baseline scenario');
    } else {
      const described = applied.map((directive) => this.describeDirective(directive));
      parts.push(`Applied ${described.join(', ')}`);
    }

    if (ignored > 0) {
      parts.push(`${ignored} unrelated note${ignored > 1 ? 's were' : ' was'} ignored as no_op`);
    }

    const chargeHours = plan.filter((entry) => entry.battery_action === 'charge').length;
    const dischargeHours = plan.filter((entry) => entry.battery_action === 'discharge').length;
    const solarUsed = plan.reduce((sum, entry) => sum + entry.solar_used_kwh, 0);

    parts.push(
      `the plan charges the battery in ${chargeHours} hour${chargeHours === 1 ? '' : 's'} and discharges in ${dischargeHours}, shifting energy away from the highest-tariff hours`,
    );
    parts.push(
      `uses ${roundTo(solarUsed, 2)} kWh of effective solar, peaks at ${roundTo(peakGrid, 2)} kWh of grid import, costs ${roundTo(totalCost, 2)} BDT, and returns the battery to its initial level by the end of hour 23`,
    );

    return `${parts.join('; ')}.`;
  }

  private describeDirective(directive: DirectiveInterpretation): string {
    const adjustment = directive.structured_adjustment as any;
    const hours = adjustment?.hours as number[] | undefined;
    const window = hours?.length ? `hour${hours.length > 1 ? 's' : ''} ${hours.join(', ')}` : '';

    switch (directive.directive_type) {
      case 'solar_reduction':
        return `a solar reduction to ${Math.round(adjustment.factor * 100)}% in ${window}`;
      case 'minimum_battery_reserve':
        return `a ${adjustment.minimum_energy_kwh} kWh battery reserve in ${window}`;
      case 'no_charge_window':
        return `a no-charge window in ${window}`;
      case 'no_discharge_window':
        return `a no-discharge window in ${window}`;
      case 'max_grid_window':
        return `a ${adjustment.max_grid_kwh} kWh grid-import cap in ${window}`;
      default:
        return 'no adjustment';
    }
  }
}
