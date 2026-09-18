#!/usr/bin/env node
/**
 * Public sample-case runner.
 *
 *   node test/run-public-samples.mjs              live mode  - POSTs every case to a
 *                                                 running service and fully replays the
 *                                                 response (needs GEMINI_API_KEY set on
 *                                                 the service).
 *   node test/run-public-samples.mjs --offline    optimizer mode - feeds the published
 *                                                 ground-truth directives straight into
 *                                                 the compiled optimizer. Needs no API
 *                                                 key and no running service.
 *
 * Both modes check the same things the judge harness checks: schema, directive shape,
 * energy balance, effective solar, battery bounds and rate limits, directive windows,
 * end-of-day neutrality, recalculated totals, and cost versus the reference optimum.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TOLERANCE = 0.01;

const offline = process.argv.includes('--offline');
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:8000').replace(/\/$/, '');

const pack = JSON.parse(
  readFileSync(resolve(ROOT, 'sample-cases/public-sample-cases.json'), 'utf8'),
);

const results = [];

for (const testCase of pack.cases) {
  const input = testCase.input;
  const expected = testCase.expected_output;
  try {
    const actual = offline ? await runOffline(input, expected) : await runLive(input);
    const report = evaluate(input, expected, actual);
    results.push({ id: testCase.id, label: testCase.label, ...report });
  } catch (error) {
    results.push({
      id: testCase.id,
      label: testCase.label,
      valid: false,
      interpretationOk: false,
      violations: [`request failed: ${error.message}`],
      cost: null,
      referenceCost: expected.total_cost_bdt,
    });
  }
}

print(results);

// ------------------------------------------------------------------ runners ---

async function runLive(input) {
  const response = await fetch(`${baseUrl}/optimize-energy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function runOffline(input, expected) {
  const { OptimizerService } = await import(
    pathToFileURL(resolve(ROOT, 'dist/optimize/optimizer.service.js')).href
  );
  const optimizer = new OptimizerService();
  // Ground-truth directives from the published pack stand in for the LLM output.
  const { plan } = optimizer.optimize(input.hours, input.battery, expected.directive_interpretation);

  const tariff = new Map(input.hours.map((h) => [h.hour, h.tariff_bdt_per_kwh]));
  const totalGrid = plan.reduce((sum, e) => sum + e.grid_kwh, 0);
  const totalCost = plan.reduce((sum, e) => sum + e.grid_kwh * tariff.get(e.hour), 0);

  return {
    scenario_id: input.scenario_id,
    directive_interpretation: expected.directive_interpretation,
    hourly_plan: plan,
    total_grid_kwh: totalGrid,
    total_cost_bdt: totalCost,
    peak_grid_kwh: Math.max(...plan.map((e) => e.grid_kwh)),
    plan_summary: '(offline optimizer run)',
  };
}

// ---------------------------------------------------------------- evaluation ---

function evaluate(input, expected, actual) {
  const violations = [];

  if (actual.scenario_id !== input.scenario_id) {
    violations.push(`scenario_id echo mismatch: ${actual.scenario_id}`);
  }
  for (const field of [
    'directive_interpretation',
    'hourly_plan',
    'total_grid_kwh',
    'total_cost_bdt',
    'peak_grid_kwh',
    'plan_summary',
  ]) {
    if (actual[field] === undefined) violations.push(`missing response field ${field}`);
  }

  const interpretation = compareInterpretation(expected.directive_interpretation, actual.directive_interpretation);
  violations.push(...interpretation.shapeViolations);

  // The schedule is always replayed against the ORGANIZER ground truth, never against
  // whatever the service claims it interpreted - exactly as the judge does.
  const constraints = buildConstraints(input, expected.directive_interpretation);
  violations.push(...replay(input, actual.hourly_plan ?? [], constraints));
  violations.push(...checkTotals(input, actual));

  const cost = recomputeCost(input, actual.hourly_plan ?? []);
  return {
    valid: violations.length === 0,
    interpretationOk: interpretation.matches,
    interpretationDiff: interpretation.diff,
    violations,
    cost,
    referenceCost: expected.total_cost_bdt,
  };
}

function compareInterpretation(expected, actual) {
  const shapeViolations = [];
  const diff = [];

  if (!Array.isArray(actual)) {
    return { matches: false, diff: ['directive_interpretation is not an array'], shapeViolations: ['directive_interpretation is not an array'] };
  }
  if (actual.length !== expected.length) {
    shapeViolations.push(`expected ${expected.length} interpretation entries, got ${actual.length}`);
    return { matches: false, diff: shapeViolations.slice(), shapeViolations };
  }

  let matches = true;

  actual.forEach((entry, index) => {
    const want = expected[index];
    if (entry.note_index !== index) {
      shapeViolations.push(`entry ${index}: note_index is ${entry.note_index}`);
    }
    const isNoOp = entry.directive_type === 'no_op';
    if (isNoOp && (entry.applies !== false || entry.structured_adjustment !== null)) {
      shapeViolations.push(`entry ${index}: no_op must use applies=false and null adjustment`);
    }
    if (!isNoOp && entry.applies !== true) {
      shapeViolations.push(`entry ${index}: non-no_op must use applies=true`);
    }
    if (typeof entry.explanation !== 'string' || !entry.explanation.trim()) {
      shapeViolations.push(`entry ${index}: explanation is empty`);
    }

    if (entry.directive_type !== want.directive_type) {
      matches = false;
      diff.push(`note ${index}: type ${entry.directive_type} != ${want.directive_type}`);
      return;
    }
    if (want.structured_adjustment === null) return;

    const got = entry.structured_adjustment ?? {};
    const wantAdj = want.structured_adjustment;
    if (JSON.stringify(got.hours) !== JSON.stringify(wantAdj.hours)) {
      matches = false;
      diff.push(`note ${index}: hours ${JSON.stringify(got.hours)} != ${JSON.stringify(wantAdj.hours)}`);
    }
    for (const key of ['factor', 'minimum_energy_kwh', 'max_grid_kwh']) {
      if (wantAdj[key] === undefined) continue;
      if (Math.abs((got[key] ?? NaN) - wantAdj[key]) > TOLERANCE) {
        matches = false;
        diff.push(`note ${index}: ${key} ${got[key]} != ${wantAdj[key]}`);
      }
    }
  });

  return { matches, diff, shapeViolations };
}

function buildConstraints(input, directives) {
  const byHour = new Map(input.hours.map((h) => [h.hour, h]));
  const effectiveSolar = [];
  for (let h = 0; h < 24; h += 1) effectiveSolar.push(byHour.get(h).solar_kwh);

  const maxCharge = new Array(24).fill(input.battery.max_charge_kwh_per_hour);
  const maxDischarge = new Array(24).fill(input.battery.max_discharge_kwh_per_hour);
  const minReserve = new Array(24).fill(input.battery.minimum_energy_kwh);
  const maxGrid = new Array(24).fill(Infinity);

  for (const directive of directives) {
    if (!directive.applies || !directive.structured_adjustment) continue;
    const adj = directive.structured_adjustment;
    for (const h of adj.hours ?? []) {
      switch (directive.directive_type) {
        case 'solar_reduction': effectiveSolar[h] *= adj.factor; break;
        case 'minimum_battery_reserve': minReserve[h] = Math.max(minReserve[h], adj.minimum_energy_kwh); break;
        case 'no_charge_window': maxCharge[h] = 0; break;
        case 'no_discharge_window': maxDischarge[h] = 0; break;
        case 'max_grid_window': maxGrid[h] = Math.min(maxGrid[h], adj.max_grid_kwh); break;
      }
    }
  }
  return { effectiveSolar, maxCharge, maxDischarge, minReserve, maxGrid };
}

function replay(input, plan, constraints) {
  const violations = [];
  const byHour = new Map(input.hours.map((h) => [h.hour, h]));

  if (plan.length !== 24) {
    return [`hourly_plan has ${plan.length} entries, expected 24`];
  }

  let energy = input.battery.initial_energy_kwh;

  for (let h = 0; h < 24; h += 1) {
    const entry = plan[h];
    const source = byHour.get(h);
    if (!entry || entry.hour !== h) {
      violations.push(`hour ${h}: plan entry missing or out of order`);
      continue;
    }
    const charge = entry.battery_action === 'charge' ? entry.battery_kwh : 0;
    const discharge = entry.battery_action === 'discharge' ? entry.battery_kwh : 0;

    if (!['charge', 'discharge', 'idle'].includes(entry.battery_action)) {
      violations.push(`hour ${h}: invalid battery_action`);
    }
    if (entry.battery_action === 'idle' && Math.abs(entry.battery_kwh) > TOLERANCE) {
      violations.push(`hour ${h}: idle hour reports battery_kwh ${entry.battery_kwh}`);
    }
    for (const [name, value] of Object.entries({
      grid_kwh: entry.grid_kwh,
      solar_used_kwh: entry.solar_used_kwh,
      battery_kwh: entry.battery_kwh,
      battery_energy_after_kwh: entry.battery_energy_after_kwh,
    })) {
      if (!Number.isFinite(value) || value < -TOLERANCE) {
        violations.push(`hour ${h}: ${name} is ${value}`);
      }
    }
    if (entry.solar_used_kwh > constraints.effectiveSolar[h] + TOLERANCE) {
      violations.push(`hour ${h}: solar_used ${entry.solar_used_kwh} > effective ${constraints.effectiveSolar[h]}`);
    }
    const balance = entry.grid_kwh + entry.solar_used_kwh + discharge - (source.demand_kwh + charge);
    if (Math.abs(balance) > TOLERANCE) {
      violations.push(`hour ${h}: energy balance off by ${balance.toFixed(4)}`);
    }
    if (charge > constraints.maxCharge[h] + TOLERANCE) {
      violations.push(`hour ${h}: charge ${charge} > limit ${constraints.maxCharge[h]}`);
    }
    if (discharge > constraints.maxDischarge[h] + TOLERANCE) {
      violations.push(`hour ${h}: discharge ${discharge} > limit ${constraints.maxDischarge[h]}`);
    }
    if (entry.grid_kwh > constraints.maxGrid[h] + TOLERANCE) {
      violations.push(`hour ${h}: grid ${entry.grid_kwh} > cap ${constraints.maxGrid[h]}`);
    }

    energy = energy + charge - discharge;
    if (Math.abs(energy - entry.battery_energy_after_kwh) > TOLERANCE) {
      violations.push(`hour ${h}: battery level ${entry.battery_energy_after_kwh} != replayed ${energy.toFixed(4)}`);
    }
    if (entry.battery_energy_after_kwh > input.battery.capacity_kwh + TOLERANCE) {
      violations.push(`hour ${h}: battery above capacity`);
    }
    if (entry.battery_energy_after_kwh < constraints.minReserve[h] - TOLERANCE) {
      violations.push(`hour ${h}: battery ${entry.battery_energy_after_kwh} below reserve ${constraints.minReserve[h]}`);
    }
  }

  const final = plan[23]?.battery_energy_after_kwh;
  if (Math.abs(final - input.battery.initial_energy_kwh) > TOLERANCE) {
    violations.push(`end-of-day battery ${final} != initial ${input.battery.initial_energy_kwh}`);
  }
  return violations;
}

function checkTotals(input, actual) {
  const violations = [];
  const plan = actual.hourly_plan ?? [];
  const tariff = new Map(input.hours.map((h) => [h.hour, h.tariff_bdt_per_kwh]));

  const grid = plan.reduce((sum, e) => sum + (e.grid_kwh ?? 0), 0);
  const cost = plan.reduce((sum, e) => sum + (e.grid_kwh ?? 0) * (tariff.get(e.hour) ?? 0), 0);
  const peak = plan.reduce((max, e) => Math.max(max, e.grid_kwh ?? 0), 0);

  if (Math.abs(grid - actual.total_grid_kwh) > TOLERANCE) {
    violations.push(`total_grid_kwh ${actual.total_grid_kwh} != recalculated ${grid.toFixed(4)}`);
  }
  if (Math.abs(cost - actual.total_cost_bdt) > TOLERANCE) {
    violations.push(`total_cost_bdt ${actual.total_cost_bdt} != recalculated ${cost.toFixed(4)}`);
  }
  if (Math.abs(peak - actual.peak_grid_kwh) > TOLERANCE) {
    violations.push(`peak_grid_kwh ${actual.peak_grid_kwh} != recalculated ${peak.toFixed(4)}`);
  }
  return violations;
}

function recomputeCost(input, plan) {
  const tariff = new Map(input.hours.map((h) => [h.hour, h.tariff_bdt_per_kwh]));
  return plan.reduce((sum, e) => sum + (e.grid_kwh ?? 0) * (tariff.get(e.hour) ?? 0), 0);
}

// -------------------------------------------------------------------- output ---

function print(rows) {
  const mode = offline ? 'OFFLINE (optimizer only)' : `LIVE (${baseUrl})`;
  console.log(`\nGridWise public sample cases - ${mode}\n`);
  console.log(
    'case        valid  interp  cost         reference    quality'.padEnd(70),
  );
  console.log('-'.repeat(70));

  let validCount = 0;
  let interpCount = 0;
  let qualitySum = 0;

  for (const row of rows) {
    const quality =
      row.cost === null || !row.valid
        ? 0
        : row.cost <= TOLERANCE && row.referenceCost <= TOLERANCE
          ? 1
          : Math.min(1, row.referenceCost / row.cost);
    if (row.valid) validCount += 1;
    if (row.interpretationOk) interpCount += 1;
    qualitySum += quality;

    console.log(
      [
        row.id.padEnd(11),
        (row.valid ? 'PASS ' : 'FAIL ').padEnd(6),
        (row.interpretationOk ? 'OK    ' : 'DIFF  ').padEnd(7),
        (row.cost === null ? '-' : row.cost.toFixed(2)).padStart(11),
        row.referenceCost.toFixed(2).padStart(12),
        quality.toFixed(4).padStart(9),
      ].join(' '),
    );

    for (const violation of row.violations ?? []) console.log(`            ! ${violation}`);
    for (const diff of row.interpretationDiff ?? []) console.log(`            ~ ${diff}`);
  }

  console.log('-'.repeat(70));
  console.log(
    `${validCount}/${rows.length} valid, ${interpCount}/${rows.length} interpretation matches, ` +
      `mean cost quality ${(qualitySum / rows.length).toFixed(4)}\n`,
  );

  process.exitCode = validCount === rows.length ? 0 : 1;
}
