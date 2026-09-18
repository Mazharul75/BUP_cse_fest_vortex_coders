import { InfeasibleScheduleError } from '../../src/common/errors';
import { BatteryDto, HourEntryDto } from '../../src/optimize/dto/optimize-request.dto';
import { DirectiveInterpretation } from '../../src/optimize/dto/optimize-response.dto';
import { OptimizerService } from '../../src/optimize/optimizer.service';
import { VerifierService } from '../../src/optimize/verifier.service';

const TOL = 0.01;

const battery: BatteryDto = {
  capacity_kwh: 220,
  initial_energy_kwh: 110,
  minimum_energy_kwh: 40,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
};

/** A day with cheap nights, a solar midday, and an expensive evening peak. */
function buildHours(): HourEntryDto[] {
  const demand = [90, 85, 80, 80, 85, 95, 110, 130, 150, 165, 175, 180, 185, 180, 170, 165, 170, 185, 205, 215, 205, 175, 135, 105];
  const solar = [0, 0, 0, 0, 0, 0, 5, 20, 50, 90, 130, 160, 180, 170, 140, 90, 45, 10, 0, 0, 0, 0, 0, 0];
  const tariff = [6, 6, 5, 5, 5, 6, 8, 10, 12, 14, 16, 16, 15, 14, 13, 14, 18, 22, 28, 30, 26, 18, 10, 7];
  return demand.map((value, hour) => ({
    hour,
    demand_kwh: value,
    solar_kwh: solar[hour],
    tariff_bdt_per_kwh: tariff[hour],
  }));
}

function directive(
  type: string,
  adjustment: Record<string, unknown> | null,
  noteIndex = 0,
): DirectiveInterpretation {
  return {
    note_index: noteIndex,
    applies: type !== 'no_op',
    directive_type: type as any,
    structured_adjustment: adjustment as any,
    explanation: 'test directive',
  };
}

describe('OptimizerService', () => {
  const optimizer = new OptimizerService();
  const verifier = new VerifierService();
  const hours = buildHours();

  function solve(directives: DirectiveInterpretation[]) {
    const result = optimizer.optimize(hours, battery, directives);
    const check = verifier.verify(result.plan, hours, battery, result.constraints);
    return { ...result, check };
  }

  function cost(plan: { hour: number; grid_kwh: number }[]): number {
    return plan.reduce((sum, entry) => sum + entry.grid_kwh * hours[entry.hour].tariff_bdt_per_kwh, 0);
  }

  describe('constraint model', () => {
    it('scales effective solar by the directive factor', () => {
      const model = optimizer.buildConstraintModel(hours, battery, [
        directive('solar_reduction', { hours: [12, 13], factor: 0.25 }),
      ]);
      expect(model.effectiveSolar[12]).toBeCloseTo(180 * 0.25, 6);
      expect(model.effectiveSolar[13]).toBeCloseTo(170 * 0.25, 6);
      expect(model.effectiveSolar[11]).toBe(160);
    });

    it('raises the reserve floor without lowering the base minimum', () => {
      const model = optimizer.buildConstraintModel(hours, battery, [
        directive('minimum_battery_reserve', { hours: [18, 19], minimum_energy_kwh: 120 }),
      ]);
      expect(model.minReserve[18]).toBe(120);
      expect(model.minReserve[0]).toBe(battery.minimum_energy_kwh);
    });

    it('never lowers a reserve below the base minimum', () => {
      const model = optimizer.buildConstraintModel(hours, battery, [
        directive('minimum_battery_reserve', { hours: [5], minimum_energy_kwh: 10 }),
      ]);
      expect(model.minReserve[5]).toBe(battery.minimum_energy_kwh);
    });

    it('zeroes the charge and discharge limits in their windows', () => {
      const model = optimizer.buildConstraintModel(hours, battery, [
        directive('no_charge_window', { hours: [2, 3] }, 0),
        directive('no_discharge_window', { hours: [18] }, 1),
      ]);
      expect(model.maxCharge[2]).toBe(0);
      expect(model.maxCharge[4]).toBe(battery.max_charge_kwh_per_hour);
      expect(model.maxDischarge[18]).toBe(0);
    });

    it('keeps the tightest cap when grid windows overlap', () => {
      const model = optimizer.buildConstraintModel(hours, battery, [
        directive('max_grid_window', { hours: [19, 20], max_grid_kwh: 180 }, 0),
        directive('max_grid_window', { hours: [20], max_grid_kwh: 150 }, 1),
      ]);
      expect(model.maxGrid[19]).toBe(180);
      expect(model.maxGrid[20]).toBe(150);
      expect(model.maxGrid[0]).toBe(Infinity);
    });

    it('ignores no_op directives', () => {
      const model = optimizer.buildConstraintModel(hours, battery, [directive('no_op', null)]);
      expect(model.effectiveSolar).toEqual(hours.map((h) => h.solar_kwh));
      expect(model.maxGrid.every((value) => value === Infinity)).toBe(true);
    });
  });

  describe('schedule validity', () => {
    it('produces a fully valid baseline plan', () => {
      const { plan, check } = solve([]);
      expect(check.violations).toEqual([]);
      expect(plan).toHaveLength(24);
      expect(plan.map((entry) => entry.hour)).toEqual([...Array(24).keys()]);
    });

    it('satisfies the energy balance every hour', () => {
      const { plan } = solve([]);
      for (const entry of plan) {
        const charge = entry.battery_action === 'charge' ? entry.battery_kwh : 0;
        const discharge = entry.battery_action === 'discharge' ? entry.battery_kwh : 0;
        expect(
          entry.grid_kwh + entry.solar_used_kwh + discharge - (hours[entry.hour].demand_kwh + charge),
        ).toBeCloseTo(0, 4);
      }
    });

    it('returns the battery to its initial level', () => {
      const { plan } = solve([]);
      expect(plan[23].battery_energy_after_kwh).toBeCloseTo(battery.initial_energy_kwh, 4);
    });

    it('reports zero battery_kwh on idle hours only', () => {
      const { plan } = solve([]);
      for (const entry of plan) {
        if (entry.battery_action === 'idle') expect(entry.battery_kwh).toBe(0);
        else expect(entry.battery_kwh).toBeGreaterThan(0);
      }
    });

    it('never emits a negative value', () => {
      const { plan } = solve([]);
      for (const entry of plan) {
        expect(entry.grid_kwh).toBeGreaterThanOrEqual(0);
        expect(entry.solar_used_kwh).toBeGreaterThanOrEqual(0);
        expect(entry.battery_kwh).toBeGreaterThanOrEqual(0);
        expect(entry.battery_energy_after_kwh).toBeGreaterThanOrEqual(0);
      }
    });

    it('keeps battery energy inside its bounds', () => {
      const { plan } = solve([]);
      for (const entry of plan) {
        expect(entry.battery_energy_after_kwh).toBeLessThanOrEqual(battery.capacity_kwh + TOL);
        expect(entry.battery_energy_after_kwh).toBeGreaterThanOrEqual(battery.minimum_energy_kwh - TOL);
      }
    });

    it('respects the hourly charge and discharge rate limits', () => {
      const { plan } = solve([]);
      for (const entry of plan) {
        expect(entry.battery_kwh).toBeLessThanOrEqual(battery.max_charge_kwh_per_hour + TOL);
      }
    });
  });

  describe('directive application', () => {
    it('never uses more than the reduced solar', () => {
      const { plan, constraints, check } = solve([
        directive('solar_reduction', { hours: [12, 13], factor: 0.25 }),
      ]);
      expect(check.violations).toEqual([]);
      expect(plan[12].solar_used_kwh).toBeLessThanOrEqual(constraints.effectiveSolar[12] + TOL);
      expect(plan[13].solar_used_kwh).toBeLessThanOrEqual(constraints.effectiveSolar[13] + TOL);
    });

    it('does not charge inside a no_charge_window', () => {
      const { plan, check } = solve([directive('no_charge_window', { hours: [2, 3, 4] })]);
      expect(check.violations).toEqual([]);
      for (const hour of [2, 3, 4]) {
        expect(plan[hour].battery_action).not.toBe('charge');
      }
    });

    it('does not discharge inside a no_discharge_window', () => {
      const { plan, check } = solve([directive('no_discharge_window', { hours: [18, 19] })]);
      expect(check.violations).toEqual([]);
      for (const hour of [18, 19]) {
        expect(plan[hour].battery_action).not.toBe('discharge');
      }
    });

    it('holds the reserve through the whole window', () => {
      const { plan, check } = solve([
        directive('minimum_battery_reserve', { hours: [18, 19, 20], minimum_energy_kwh: 150 }),
      ]);
      expect(check.violations).toEqual([]);
      for (const hour of [18, 19, 20]) {
        expect(plan[hour].battery_energy_after_kwh).toBeGreaterThanOrEqual(150 - TOL);
      }
    });

    it('caps grid import inside a max_grid_window', () => {
      const { plan, check } = solve([
        directive('max_grid_window', { hours: [18, 19, 20], max_grid_kwh: 170 }),
      ]);
      expect(check.violations).toEqual([]);
      for (const hour of [18, 19, 20]) {
        expect(plan[hour].grid_kwh).toBeLessThanOrEqual(170 + TOL);
      }
    });

    it('applies several directives at once', () => {
      const { plan, check } = solve([
        directive('solar_reduction', { hours: [10, 11], factor: 0.5 }, 0),
        directive('no_charge_window', { hours: [14, 15] }, 1),
        directive('max_grid_window', { hours: [19], max_grid_kwh: 180 }, 2),
      ]);
      expect(check.violations).toEqual([]);
      expect(plan[14].battery_action).not.toBe('charge');
      expect(plan[15].battery_action).not.toBe('charge');
      expect(plan[19].grid_kwh).toBeLessThanOrEqual(180 + TOL);
    });

    it('costs no less than the unconstrained optimum once a directive binds', () => {
      const baseline = solve([]);
      const restricted = solve([
        directive('max_grid_window', { hours: [18, 19, 20], max_grid_kwh: 170 }),
      ]);
      expect(cost(restricted.plan)).toBeGreaterThanOrEqual(cost(baseline.plan) - TOL);
    });

    it('beats a battery-idle schedule on cost', () => {
      const { plan } = solve([]);
      const passiveCost = hours.reduce(
        (sum, entry) => sum + Math.max(0, entry.demand_kwh - entry.solar_kwh) * entry.tariff_bdt_per_kwh,
        0,
      );
      expect(cost(plan)).toBeLessThan(passiveCost);
    });
  });

  describe('failure handling', () => {
    it('throws InfeasibleScheduleError when a reserve cannot be met', () => {
      const impossible = [
        directive('minimum_battery_reserve', { hours: [5], minimum_energy_kwh: 220 }, 0),
        directive('no_charge_window', { hours: [...Array(24).keys()] }, 1),
      ];
      expect(() => optimizer.optimize(hours, battery, impossible)).toThrow(InfeasibleScheduleError);
    });

    it('throws when the scenario is missing an hour', () => {
      const short = hours.filter((entry) => entry.hour !== 7);
      expect(() => optimizer.optimize(short, battery, [])).toThrow(InfeasibleScheduleError);
    });

    it('handles a zero-solar, flat-tariff day', () => {
      const flat = hours.map((entry) => ({ ...entry, solar_kwh: 0, tariff_bdt_per_kwh: 10 }));
      const result = optimizer.optimize(flat, battery, []);
      const check = verifier.verify(result.plan, flat, battery, result.constraints);
      expect(check.violations).toEqual([]);
    });

    it('handles a battery with no usable capacity', () => {
      const locked: BatteryDto = {
        capacity_kwh: 100,
        initial_energy_kwh: 100,
        minimum_energy_kwh: 100,
        max_charge_kwh_per_hour: 0,
        max_discharge_kwh_per_hour: 0,
      };
      const result = optimizer.optimize(hours, locked, []);
      const check = verifier.verify(result.plan, hours, locked, result.constraints);
      expect(check.violations).toEqual([]);
      expect(result.plan.every((entry) => entry.battery_action === 'idle')).toBe(true);
    });
  });
});
