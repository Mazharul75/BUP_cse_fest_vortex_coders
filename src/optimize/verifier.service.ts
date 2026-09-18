import { Injectable } from '@nestjs/common';
import { HOURS_IN_DAY, JUDGE_TOLERANCE } from './constants';
import { BatteryDto, HourEntryDto } from './dto/optimize-request.dto';
import { HourlyPlanEntry } from './dto/optimize-response.dto';
import { ConstraintModel } from './optimizer.service';

export interface VerificationResult {
  valid: boolean;
  violations: string[];
}

/**
 * Final replay (Problem Statement 08). The completed schedule is replayed hour by
 * hour against the same constraint model the optimizer was given, to confirm every
 * extracted directive was actually followed. This mirrors what the judge harness
 * does independently, so a schedule that would be rejected there is caught here first.
 */
@Injectable()
export class VerifierService {
  verify(
    plan: HourlyPlanEntry[],
    hours: HourEntryDto[],
    battery: BatteryDto,
    constraints: ConstraintModel,
  ): VerificationResult {
    const violations: string[] = [];
    const byHour = new Map(hours.map((entry) => [entry.hour, entry]));
    const tol = JUDGE_TOLERANCE;

    if (plan.length !== HOURS_IN_DAY) {
      violations.push(`hourly_plan has ${plan.length} entries, expected ${HOURS_IN_DAY}`);
      return { valid: false, violations };
    }

    let energy = battery.initial_energy_kwh;

    for (let h = 0; h < HOURS_IN_DAY; h += 1) {
      const entry = plan[h];
      const source = byHour.get(h);

      if (entry.hour !== h) {
        violations.push(`hourly_plan entry ${h} reports hour ${entry.hour}`);
        continue;
      }
      if (!source) {
        violations.push(`Scenario is missing hour ${h}`);
        continue;
      }

      const numbers = [
        entry.grid_kwh,
        entry.solar_used_kwh,
        entry.battery_kwh,
        entry.battery_energy_after_kwh,
      ];
      if (numbers.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
        violations.push(`hour ${h}: non-finite numeric value in plan`);
        continue;
      }
      if (numbers.some((value) => value < -tol)) {
        violations.push(`hour ${h}: negative energy value in plan`);
      }

      const charge = entry.battery_action === 'charge' ? entry.battery_kwh : 0;
      const discharge = entry.battery_action === 'discharge' ? entry.battery_kwh : 0;

      if (entry.battery_action === 'idle' && Math.abs(entry.battery_kwh) > tol) {
        violations.push(`hour ${h}: battery_kwh must be 0 when idle`);
      }
      if (!['charge', 'discharge', 'idle'].includes(entry.battery_action)) {
        violations.push(`hour ${h}: invalid battery_action "${entry.battery_action}"`);
      }

      // Effective solar after any solar_reduction directive.
      if (entry.solar_used_kwh > constraints.effectiveSolar[h] + tol) {
        violations.push(
          `hour ${h}: solar_used_kwh ${entry.solar_used_kwh} exceeds effective solar ${constraints.effectiveSolar[h]}`,
        );
      }

      // Energy balance.
      const lhs = entry.grid_kwh + entry.solar_used_kwh + discharge;
      const rhs = source.demand_kwh + charge;
      if (Math.abs(lhs - rhs) > tol) {
        violations.push(
          `hour ${h}: energy balance off by ${(lhs - rhs).toFixed(6)} kWh`,
        );
      }

      // Rate limits, including no_charge_window / no_discharge_window (which set the
      // relevant limit to 0 in the constraint model).
      if (charge > constraints.maxCharge[h] + tol) {
        violations.push(`hour ${h}: charge ${charge} exceeds limit ${constraints.maxCharge[h]}`);
      }
      if (discharge > constraints.maxDischarge[h] + tol) {
        violations.push(
          `hour ${h}: discharge ${discharge} exceeds limit ${constraints.maxDischarge[h]}`,
        );
      }

      // Grid cap from max_grid_window.
      if (entry.grid_kwh > constraints.maxGrid[h] + tol) {
        violations.push(
          `hour ${h}: grid_kwh ${entry.grid_kwh} exceeds cap ${constraints.maxGrid[h]}`,
        );
      }

      // Battery state transition and bounds, including minimum_battery_reserve.
      energy = energy + charge - discharge;
      if (Math.abs(energy - entry.battery_energy_after_kwh) > tol) {
        violations.push(
          `hour ${h}: battery_energy_after_kwh ${entry.battery_energy_after_kwh} does not match replayed ${energy}`,
        );
      }
      if (entry.battery_energy_after_kwh > battery.capacity_kwh + tol) {
        violations.push(`hour ${h}: battery energy exceeds capacity`);
      }
      if (entry.battery_energy_after_kwh < constraints.minReserve[h] - tol) {
        violations.push(
          `hour ${h}: battery energy ${entry.battery_energy_after_kwh} below required reserve ${constraints.minReserve[h]}`,
        );
      }
    }

    // End-of-day neutrality.
    const final = plan[HOURS_IN_DAY - 1]?.battery_energy_after_kwh;
    if (typeof final === 'number' && Math.abs(final - battery.initial_energy_kwh) > tol) {
      violations.push(
        `end-of-day battery ${final} does not equal initial ${battery.initial_energy_kwh}`,
      );
    }

    return { valid: violations.length === 0, violations };
  }
}
