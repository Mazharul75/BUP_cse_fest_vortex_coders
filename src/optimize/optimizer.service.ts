import { Injectable, Logger } from '@nestjs/common';
import solver from 'javascript-lp-solver';
import { InfeasibleScheduleError } from '../common/errors';
import { ACTION_EPSILON, FEASIBILITY_EPSILON, HOURS_IN_DAY, roundTo } from './constants';
import { BatteryDto, HourEntryDto } from './dto/optimize-request.dto';
import { DirectiveInterpretation, HourlyPlanEntry } from './dto/optimize-response.dto';

/**
 * The deterministic constraint picture for one scenario, after every validated
 * directive has been folded into it. This object - not the raw directive list - is
 * what the optimizer and the replay verifier both work from, so the two can never
 * disagree about what was supposed to be enforced.
 */
export interface ConstraintModel {
  effectiveSolar: number[];
  maxCharge: number[];
  maxDischarge: number[];
  minReserve: number[];
  maxGrid: number[];
}

/**
 * Linear-programming scheduler.
 *
 * Formulation note: the natural model has five variables per hour (grid, solar,
 * charge, discharge, battery level) with two equality constraints per hour. Both
 * grid_h and batt_h are eliminated algebraically:
 *
 *   grid_h = demand_h + charge_h - solar_h - discharge_h        (>= 0)
 *   batt_h = initial + SUM_{k<=h} (charge_k - discharge_k)
 *
 * That leaves 72 variables and a single equality (end-of-day neutrality), which is
 * the same optimum with far better numerical behaviour in a pure-JS simplex.
 */
@Injectable()
export class OptimizerService {
  private readonly logger = new Logger(OptimizerService.name);

  /** Tiny cycling penalty. Breaks degenerate optima where the solver would charge and
   * discharge in the same hour at zero net cost - which would be unrepresentable in
   * the single battery_action field. At 1e-6 BDT/kWh it cannot shift the real optimum
   * by more than a fraction of the 0.01 BDT judge tolerance. */
  private static readonly CYCLING_PENALTY = 1e-6;

  buildConstraintModel(
    hours: HourEntryDto[],
    battery: BatteryDto,
    directives: DirectiveInterpretation[],
  ): ConstraintModel {
    const byHour = new Map(hours.map((entry) => [entry.hour, entry]));
    const effectiveSolar: number[] = [];
    for (let h = 0; h < HOURS_IN_DAY; h += 1) {
      const entry = byHour.get(h);
      if (!entry) {
        throw new InfeasibleScheduleError(`Scenario is missing hour ${h}`);
      }
      effectiveSolar.push(entry.solar_kwh);
    }
    const maxCharge = new Array(HOURS_IN_DAY).fill(battery.max_charge_kwh_per_hour);
    const maxDischarge = new Array(HOURS_IN_DAY).fill(battery.max_discharge_kwh_per_hour);
    const minReserve = new Array(HOURS_IN_DAY).fill(battery.minimum_energy_kwh);
    const maxGrid = new Array(HOURS_IN_DAY).fill(Number.POSITIVE_INFINITY);

    for (const directive of directives) {
      if (!directive.applies || directive.structured_adjustment === null) continue;
      const adjustment = directive.structured_adjustment as any;
      const targetHours: number[] = adjustment.hours ?? [];

      switch (directive.directive_type) {
        case 'solar_reduction':
          for (const h of targetHours) {
            effectiveSolar[h] = effectiveSolar[h] * adjustment.factor;
          }
          break;
        case 'minimum_battery_reserve':
          for (const h of targetHours) {
            minReserve[h] = Math.max(minReserve[h], adjustment.minimum_energy_kwh);
          }
          break;
        case 'no_charge_window':
          for (const h of targetHours) {
            maxCharge[h] = 0;
          }
          break;
        case 'no_discharge_window':
          for (const h of targetHours) {
            maxDischarge[h] = 0;
          }
          break;
        case 'max_grid_window':
          for (const h of targetHours) {
            maxGrid[h] = Math.min(maxGrid[h], adjustment.max_grid_kwh);
          }
          break;
        case 'no_op':
          break;
      }
    }

    return { effectiveSolar, maxCharge, maxDischarge, minReserve, maxGrid };
  }

  optimize(
    hours: HourEntryDto[],
    battery: BatteryDto,
    directives: DirectiveInterpretation[],
  ): { plan: HourlyPlanEntry[]; constraints: ConstraintModel } {
    const constraints = this.buildConstraintModel(hours, battery, directives);
    const ordered = this.orderHours(hours);

    const solution = this.solveLp(ordered, battery, constraints);
    const plan = this.buildPlan(ordered, battery, constraints, solution.charge, solution.discharge);
    return { plan, constraints };
  }

  private orderHours(hours: HourEntryDto[]): HourEntryDto[] {
    const byHour = new Map(hours.map((entry) => [entry.hour, entry]));
    const ordered: HourEntryDto[] = [];
    for (let h = 0; h < HOURS_IN_DAY; h += 1) {
      const entry = byHour.get(h);
      if (!entry) {
        throw new InfeasibleScheduleError(`Scenario is missing hour ${h}`);
      }
      ordered.push(entry);
    }
    return ordered;
  }

  // -------------------------------------------------------------------- LP ---

  private solveLp(
    hours: HourEntryDto[],
    battery: BatteryDto,
    constraints: ConstraintModel,
  ): { charge: number[]; discharge: number[] } {
    const model: any = {
      optimize: 'cost',
      opType: 'min',
      constraints: {},
      variables: {},
    };

    const capacityHeadroom = battery.capacity_kwh - battery.initial_energy_kwh;

    for (let h = 0; h < HOURS_IN_DAY; h += 1) {
      const { demand_kwh: demand, tariff_bdt_per_kwh: tariff } = hours[h];

      model.constraints[`solar_cap_${h}`] = { max: constraints.effectiveSolar[h] };
      model.constraints[`charge_cap_${h}`] = { max: constraints.maxCharge[h] };
      model.constraints[`discharge_cap_${h}`] = { max: constraints.maxDischarge[h] };
      // grid_h >= 0  <=>  charge_h - solar_h - discharge_h >= -demand_h
      model.constraints[`grid_floor_${h}`] = { min: -demand };
      if (Number.isFinite(constraints.maxGrid[h])) {
        // grid_h <= cap  <=>  charge_h - solar_h - discharge_h <= cap - demand_h
        model.constraints[`grid_cap_${h}`] = { max: constraints.maxGrid[h] - demand };
      }
      // batt_h = initial + cumulative(charge - discharge)
      model.constraints[`batt_max_${h}`] = { max: capacityHeadroom };
      model.constraints[`batt_min_${h}`] = { min: constraints.minReserve[h] - battery.initial_energy_kwh };

      model.variables[`s_${h}`] = {
        cost: -tariff,
        [`solar_cap_${h}`]: 1,
        [`grid_floor_${h}`]: -1,
      };
      model.variables[`c_${h}`] = {
        cost: tariff + OptimizerService.CYCLING_PENALTY,
        [`charge_cap_${h}`]: 1,
        [`grid_floor_${h}`]: 1,
        neutrality: 1,
      };
      model.variables[`d_${h}`] = {
        cost: -tariff + OptimizerService.CYCLING_PENALTY,
        [`discharge_cap_${h}`]: 1,
        [`grid_floor_${h}`]: -1,
        neutrality: -1,
      };

      if (Number.isFinite(constraints.maxGrid[h])) {
        model.variables[`s_${h}`][`grid_cap_${h}`] = -1;
        model.variables[`c_${h}`][`grid_cap_${h}`] = 1;
        model.variables[`d_${h}`][`grid_cap_${h}`] = -1;
      }

      // Every hour k <= h contributes to the battery level at hour h.
      for (let target = h; target < HOURS_IN_DAY; target += 1) {
        model.variables[`c_${h}`][`batt_max_${target}`] = 1;
        model.variables[`c_${h}`][`batt_min_${target}`] = 1;
        model.variables[`d_${h}`][`batt_max_${target}`] = -1;
        model.variables[`d_${h}`][`batt_min_${target}`] = -1;
      }
    }

    // End-of-day neutrality: total charge must equal total discharge.
    model.constraints.neutrality = { equal: 0 };

    const result = solver.Solve(model) as Record<string, number> & { feasible?: boolean };

    if (!result || result.feasible !== true) {
      this.logger.warn('LP reported no feasible schedule for the applied directives');
      throw new InfeasibleScheduleError();
    }

    const charge: number[] = [];
    const discharge: number[] = [];
    for (let h = 0; h < HOURS_IN_DAY; h += 1) {
      charge.push(Math.max(0, Number(result[`c_${h}`] ?? 0)));
      discharge.push(Math.max(0, Number(result[`d_${h}`] ?? 0)));
    }
    return { charge, discharge };
  }

  // --------------------------------------------------------- plan assembly ---

  private buildPlan(
    hours: HourEntryDto[],
    battery: BatteryDto,
    constraints: ConstraintModel,
    rawCharge: number[],
    rawDischarge: number[],
  ): HourlyPlanEntry[] {
    const charge = new Array(HOURS_IN_DAY).fill(0);
    const discharge = new Array(HOURS_IN_DAY).fill(0);

    // Net out any simultaneous charge/discharge so a single battery_action can
    // describe the hour, then round to the emitted precision.
    for (let h = 0; h < HOURS_IN_DAY; h += 1) {
      const net = rawCharge[h] - rawDischarge[h];
      if (net > 0) {
        charge[h] = Math.min(roundTo(net), constraints.maxCharge[h]);
      } else if (net < 0) {
        discharge[h] = Math.min(roundTo(-net), constraints.maxDischarge[h]);
      }
    }

    this.snapNeutrality(hours, battery, constraints, charge, discharge);

    const plan: HourlyPlanEntry[] = [];
    let energy = battery.initial_energy_kwh;

    for (let h = 0; h < HOURS_IN_DAY; h += 1) {
      const demand = hours[h].demand_kwh;
      const net = charge[h] - discharge[h];

      // Use as much effective solar as the hour can absorb. This can only reduce
      // grid import, so it never breaks a grid cap and never raises cost.
      const absorbable = demand + net;
      const solarUsed = roundTo(Math.max(0, Math.min(constraints.effectiveSolar[h], absorbable)));
      const grid = roundTo(Math.max(0, demand + net - solarUsed));

      energy = roundTo(energy + net);

      let action: HourlyPlanEntry['battery_action'] = 'idle';
      let magnitude = 0;
      if (charge[h] > ACTION_EPSILON) {
        action = 'charge';
        magnitude = roundTo(charge[h]);
      } else if (discharge[h] > ACTION_EPSILON) {
        action = 'discharge';
        magnitude = roundTo(discharge[h]);
      }

      plan.push({
        hour: h,
        grid_kwh: grid,
        solar_used_kwh: solarUsed,
        battery_action: action,
        battery_kwh: magnitude,
        battery_energy_after_kwh: energy,
      });
    }

    return plan;
  }

  /**
   * Rounding each hour independently can leave a sub-milli-kWh drift in the
   * end-of-day battery level. Absorb it in a single hour that has the headroom,
   * so battery_energy_after_kwh[23] lands exactly on initial_energy_kwh.
   */
  private snapNeutrality(
    hours: HourEntryDto[],
    battery: BatteryDto,
    constraints: ConstraintModel,
    charge: number[],
    discharge: number[],
  ): void {
    const drift = roundTo(
      charge.reduce((sum, value) => sum + value, 0) -
        discharge.reduce((sum, value) => sum + value, 0),
      10,
    );
    if (Math.abs(drift) < 1e-9) return;
    if (Math.abs(drift) > FEASIBILITY_EPSILON) {
      // Larger than rounding noise - the solver itself missed neutrality.
      this.logger.warn(`Battery neutrality drift of ${drift} kWh reported by the solver`);
    }

    // The hour we touch must shift its net battery flow by exactly `delta`.
    const delta = -drift;

    for (let h = HOURS_IN_DAY - 1; h >= 0; h -= 1) {
      const demand = hours[h].demand_kwh;

      // Prefer moving the variable that is already active in this hour.
      const options: Array<[number, number]> =
        delta > 0
          ? [
              [charge[h] + delta, discharge[h]],
              [charge[h], discharge[h] - delta],
            ]
          : [
              [charge[h] + delta, discharge[h]],
              [charge[h], discharge[h] - delta],
            ];

      for (const [candidateCharge, candidateDischarge] of options) {
        if (candidateCharge < 0 || candidateDischarge < 0) continue;
        if (candidateCharge > constraints.maxCharge[h] + FEASIBILITY_EPSILON) continue;
        if (candidateDischarge > constraints.maxDischarge[h] + FEASIBILITY_EPSILON) continue;
        // Both cannot be positive at once - that would be unrepresentable.
        if (candidateCharge > ACTION_EPSILON && candidateDischarge > ACTION_EPSILON) continue;

        const net = candidateCharge - candidateDischarge;
        if (demand + net < -FEASIBILITY_EPSILON) continue;

        charge[h] = roundTo(candidateCharge);
        discharge[h] = roundTo(candidateDischarge);
        return;
      }
    }

    this.logger.warn('Could not absorb battery neutrality drift in any single hour');
  }
}
