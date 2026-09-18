/**
 * Canonical constants for the GridWise LLM preliminary.
 * Source of truth: BUP CSE Fest 2026 Preliminary Problem Statement, sections 04, 09 and 11.
 */

export const DIRECTIVE_TYPES = [
  'solar_reduction',
  'minimum_battery_reserve',
  'no_charge_window',
  'no_discharge_window',
  'max_grid_window',
  'no_op',
] as const;

export type DirectiveType = (typeof DIRECTIVE_TYPES)[number];

/** Fields allowed inside structured_adjustment, per directive type. */
export const ADJUSTMENT_FIELDS: Record<Exclude<DirectiveType, 'no_op'>, string[]> = {
  solar_reduction: ['hours', 'factor'],
  minimum_battery_reserve: ['hours', 'minimum_energy_kwh'],
  no_charge_window: ['hours'],
  no_discharge_window: ['hours'],
  max_grid_window: ['hours', 'max_grid_kwh'],
};

export const HOURS_IN_DAY = 24;

/** Judge tolerance: 0.01 kWh / 0.01 BDT (Problem Statement 11.5). */
export const JUDGE_TOLERANCE = 0.01;

/** Internal feasibility tolerance - an order of magnitude tighter than the judge's. */
export const FEASIBILITY_EPSILON = 1e-4;

/** Values below this are treated as zero when classifying a battery action. */
export const ACTION_EPSILON = 1e-4;

/** Decimal places used for every number emitted in hourly_plan. */
export const OUTPUT_DECIMALS = 6;

export function roundTo(value: number, decimals = OUTPUT_DECIMALS): number {
  const factor = 10 ** decimals;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  // Normalise -0 to 0 so the response never contains a negative zero.
  return rounded === 0 ? 0 : rounded;
}
