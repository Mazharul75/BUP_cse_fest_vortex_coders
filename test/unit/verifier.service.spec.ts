import { BatteryDto, HourEntryDto } from '../../src/optimize/dto/optimize-request.dto';
import { HourlyPlanEntry } from '../../src/optimize/dto/optimize-response.dto';
import { ConstraintModel } from '../../src/optimize/optimizer.service';
import { VerifierService } from '../../src/optimize/verifier.service';

const battery: BatteryDto = {
  capacity_kwh: 200,
  initial_energy_kwh: 100,
  minimum_energy_kwh: 40,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
};

/** Flat day: 100 kWh demand, 0 solar, 10 BDT/kWh. */
const hours: HourEntryDto[] = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  demand_kwh: 100,
  solar_kwh: 0,
  tariff_bdt_per_kwh: 10,
}));

function baseConstraints(): ConstraintModel {
  return {
    effectiveSolar: new Array(24).fill(0),
    maxCharge: new Array(24).fill(battery.max_charge_kwh_per_hour),
    maxDischarge: new Array(24).fill(battery.max_discharge_kwh_per_hour),
    minReserve: new Array(24).fill(battery.minimum_energy_kwh),
    maxGrid: new Array(24).fill(Number.POSITIVE_INFINITY),
  };
}

/** Grid-only plan: always valid against the base constraints. */
function basePlan(): HourlyPlanEntry[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    grid_kwh: 100,
    solar_used_kwh: 0,
    battery_action: 'idle' as const,
    battery_kwh: 0,
    battery_energy_after_kwh: 100,
  }));
}

describe('VerifierService', () => {
  const verifier = new VerifierService();

  it('accepts a valid grid-only plan', () => {
    const result = verifier.verify(basePlan(), hours, battery, baseConstraints());
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts a valid charge/discharge pair', () => {
    const plan = basePlan();
    plan[0] = { hour: 0, grid_kwh: 130, solar_used_kwh: 0, battery_action: 'charge', battery_kwh: 30, battery_energy_after_kwh: 130 };
    plan[1] = { hour: 1, grid_kwh: 70, solar_used_kwh: 0, battery_action: 'discharge', battery_kwh: 30, battery_energy_after_kwh: 100 };
    expect(verifier.verify(plan, hours, battery, baseConstraints()).violations).toEqual([]);
  });

  it('rejects a plan with the wrong number of hours', () => {
    const result = verifier.verify(basePlan().slice(0, 23), hours, battery, baseConstraints());
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatch(/23 entries/);
  });

  it('rejects an out-of-order hour', () => {
    const plan = basePlan();
    plan[5].hour = 6;
    expect(verifier.verify(plan, hours, battery, baseConstraints()).valid).toBe(false);
  });

  it('rejects an energy-balance failure', () => {
    const plan = basePlan();
    plan[3].grid_kwh = 90;
    const result = verifier.verify(plan, hours, battery, baseConstraints());
    expect(result.valid).toBe(false);
    expect(result.violations.join(' ')).toMatch(/energy balance/);
  });

  it('rejects solar use above the effective limit', () => {
    const constraints = baseConstraints();
    constraints.effectiveSolar[10] = 20;
    const plan = basePlan();
    plan[10] = { ...plan[10], grid_kwh: 50, solar_used_kwh: 50 };
    const result = verifier.verify(plan, hours, battery, constraints);
    expect(result.violations.join(' ')).toMatch(/exceeds effective solar/);
  });

  it('rejects a charge inside a no_charge_window', () => {
    const constraints = baseConstraints();
    constraints.maxCharge[4] = 0;
    const plan = basePlan();
    plan[4] = { hour: 4, grid_kwh: 110, solar_used_kwh: 0, battery_action: 'charge', battery_kwh: 10, battery_energy_after_kwh: 110 };
    for (let h = 5; h < 24; h += 1) plan[h].battery_energy_after_kwh = 110;
    const result = verifier.verify(plan, hours, battery, constraints);
    expect(result.violations.join(' ')).toMatch(/charge 10 exceeds limit 0/);
  });

  it('rejects a discharge inside a no_discharge_window', () => {
    const constraints = baseConstraints();
    constraints.maxDischarge[8] = 0;
    const plan = basePlan();
    plan[8] = { hour: 8, grid_kwh: 90, solar_used_kwh: 0, battery_action: 'discharge', battery_kwh: 10, battery_energy_after_kwh: 90 };
    for (let h = 9; h < 24; h += 1) plan[h].battery_energy_after_kwh = 90;
    const result = verifier.verify(plan, hours, battery, constraints);
    expect(result.violations.join(' ')).toMatch(/discharge 10 exceeds limit 0/);
  });

  it('rejects a grid import above a window cap', () => {
    const constraints = baseConstraints();
    constraints.maxGrid[19] = 80;
    const result = verifier.verify(basePlan(), hours, battery, constraints);
    expect(result.violations.join(' ')).toMatch(/exceeds cap 80/);
  });

  it('rejects a battery level below an active reserve', () => {
    const constraints = baseConstraints();
    constraints.minReserve[12] = 150;
    const result = verifier.verify(basePlan(), hours, battery, constraints);
    expect(result.violations.join(' ')).toMatch(/below required reserve 150/);
  });

  it('rejects a battery level above capacity', () => {
    const plan = basePlan();
    plan[0] = { hour: 0, grid_kwh: 150, solar_used_kwh: 0, battery_action: 'charge', battery_kwh: 50, battery_energy_after_kwh: 250 };
    const result = verifier.verify(plan, hours, battery, baseConstraints());
    expect(result.violations.join(' ')).toMatch(/exceeds capacity/);
  });

  it('rejects a charge above the hourly rate limit', () => {
    const plan = basePlan();
    plan[0] = { hour: 0, grid_kwh: 180, solar_used_kwh: 0, battery_action: 'charge', battery_kwh: 80, battery_energy_after_kwh: 180 };
    const result = verifier.verify(plan, hours, battery, baseConstraints());
    expect(result.violations.join(' ')).toMatch(/charge 80 exceeds limit 50/);
  });

  it('rejects a battery transition that does not match the reported level', () => {
    const plan = basePlan();
    plan[2].battery_energy_after_kwh = 111;
    const result = verifier.verify(plan, hours, battery, baseConstraints());
    expect(result.violations.join(' ')).toMatch(/does not match replayed/);
  });

  it('rejects a non-zero battery_kwh on an idle hour', () => {
    const plan = basePlan();
    plan[7].battery_kwh = 5;
    const result = verifier.verify(plan, hours, battery, baseConstraints());
    expect(result.violations.join(' ')).toMatch(/must be 0 when idle/);
  });

  it('rejects a broken end-of-day battery level', () => {
    const plan = basePlan();
    plan[23] = { hour: 23, grid_kwh: 70, solar_used_kwh: 0, battery_action: 'discharge', battery_kwh: 30, battery_energy_after_kwh: 70 };
    const result = verifier.verify(plan, hours, battery, baseConstraints());
    expect(result.violations.join(' ')).toMatch(/end-of-day battery/);
  });

  it('rejects negative and non-finite values', () => {
    const negative = basePlan();
    negative[6].grid_kwh = -5;
    expect(verifier.verify(negative, hours, battery, baseConstraints()).valid).toBe(false);

    const broken = basePlan();
    broken[6].grid_kwh = Number.NaN;
    const result = verifier.verify(broken, hours, battery, baseConstraints());
    expect(result.violations.join(' ')).toMatch(/non-finite/);
  });

  it('tolerates differences inside the 0.01 judge tolerance', () => {
    const plan = basePlan();
    plan[9].grid_kwh = 100.005;
    expect(verifier.verify(plan, hours, battery, baseConstraints()).valid).toBe(true);
  });
});
