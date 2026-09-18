#!/usr/bin/env node
/**
 * Live language-model interpretation check.
 *
 *   node test/run-llm-interpretation.mjs
 *
 * Calls the real Gemini interpreter (never the failure-path interpreter) on the ten
 * public sample notes plus a paraphrase set that reworded the same directives, and
 * scores the structured output against the published ground truth. Requires
 * GEMINI_API_KEY (or GEMINI_API_KEYS) in the environment or in .env.
 *
 * Requests are spaced by --gap ms (default 7000) because the Gemini free tier is
 * rate-limited per minute; raise it if you still see 429s.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TOLERANCE = 0.01;

const gapArg = process.argv.find((arg) => arg.startsWith('--gap='));
const GAP_MS = gapArg ? Number(gapArg.split('=')[1]) : 7000;

const pack = JSON.parse(readFileSync(resolve(ROOT, 'sample-cases/public-sample-cases.json'), 'utf8'));

/** Rewordings of directives the public pack already defines, to probe paraphrase robustness. */
const PARAPHRASES = [
  {
    id: 'PARA-01',
    note: 'PV production will drop to about 20% between 13:00 and 15:00.',
    battery: { capacity_kwh: 200, initial_energy_kwh: 100, minimum_energy_kwh: 40, max_charge_kwh_per_hour: 50, max_discharge_kwh_per_hour: 50 },
    expect: { directive_type: 'solar_reduction', structured_adjustment: { hours: [13, 14], factor: 0.2 } },
  },
  {
    id: 'PARA-02',
    note: 'Panel washing from one until three will leave roughly one-fifth of normal solar output.',
    battery: { capacity_kwh: 200, initial_energy_kwh: 100, minimum_energy_kwh: 40, max_charge_kwh_per_hour: 50, max_discharge_kwh_per_hour: 50 },
    expect: { directive_type: 'solar_reduction', structured_adjustment: { hours: [13, 14], factor: 0.2 } },
  },
  {
    id: 'PARA-03',
    note: 'Expect an 80% reduction in rooftop solar during the 1-3 PM maintenance window.',
    battery: { capacity_kwh: 200, initial_energy_kwh: 100, minimum_energy_kwh: 40, max_charge_kwh_per_hour: 50, max_discharge_kwh_per_hour: 50 },
    expect: { directive_type: 'solar_reduction', structured_adjustment: { hours: [13, 14], factor: 0.2 } },
  },
  {
    id: 'PARA-04',
    note: 'The storage system may not take any charge between 22:00 and midnight.',
    battery: { capacity_kwh: 200, initial_energy_kwh: 100, minimum_energy_kwh: 40, max_charge_kwh_per_hour: 50, max_discharge_kwh_per_hour: 50 },
    expect: { directive_type: 'no_charge_window', structured_adjustment: { hours: [22, 23] } },
  },
  {
    id: 'PARA-05',
    note: 'Half of the pack must stay untouched between 7 PM and 10 PM for the clinic.',
    battery: { capacity_kwh: 300, initial_energy_kwh: 150, minimum_energy_kwh: 40, max_charge_kwh_per_hour: 50, max_discharge_kwh_per_hour: 50 },
    expect: { directive_type: 'minimum_battery_reserve', structured_adjustment: { hours: [19, 20, 21], minimum_energy_kwh: 150 } },
  },
  {
    id: 'PARA-06',
    note: 'Under the substation restriction we cannot pull more than 140 kWh an hour from the grid between 6 and 8 PM.',
    battery: { capacity_kwh: 200, initial_energy_kwh: 100, minimum_energy_kwh: 40, max_charge_kwh_per_hour: 50, max_discharge_kwh_per_hour: 50 },
    expect: { directive_type: 'max_grid_window', structured_adjustment: { hours: [18, 19], max_grid_kwh: 140 } },
  },
  {
    id: 'PARA-07',
    note: 'Relay testing means the battery cannot supply anything from 5 PM to 7 PM.',
    battery: { capacity_kwh: 200, initial_energy_kwh: 100, minimum_energy_kwh: 40, max_charge_kwh_per_hour: 50, max_discharge_kwh_per_hour: 50 },
    expect: { directive_type: 'no_discharge_window', structured_adjustment: { hours: [17, 18] } },
  },
  {
    id: 'PARA-08',
    note: 'Convocation rehearsal has been rescheduled to the following Thursday.',
    battery: { capacity_kwh: 200, initial_energy_kwh: 100, minimum_energy_kwh: 40, max_charge_kwh_per_hour: 50, max_discharge_kwh_per_hour: 50 },
    expect: { directive_type: 'no_op', structured_adjustment: null },
  },
];

const { InterpreterService } = await import(
  pathToFileURL(resolve(ROOT, 'dist/optimize/interpreter.service.js')).href
);
const { GuardrailsService } = await import(
  pathToFileURL(resolve(ROOT, 'dist/optimize/guardrails.service.js')).href
);

loadDotEnv();

if (!process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEYS) {
  console.error('GEMINI_API_KEY (or GEMINI_API_KEYS) is required for this test.');
  process.exit(2);
}

const config = { get: (key) => process.env[key] };
const interpreter = new InterpreterService(config);
interpreter.onModuleInit();
const guardrails = new GuardrailsService();

const rows = [];

for (const testCase of pack.cases) {
  rows.push(
    await score(
      testCase.id,
      testCase.input.operator_notes,
      testCase.input.battery,
      testCase.expected_output.directive_interpretation,
    ),
  );
  await sleep(GAP_MS);
}

for (const para of PARAPHRASES) {
  rows.push(await score(para.id, [para.note], para.battery, [{ note_index: 0, ...para.expect }]));
  await sleep(GAP_MS);
}

report(rows);

// ------------------------------------------------------------------ helpers ---

async function score(id, notes, battery, expected) {
  try {
    const { directives, source } = await interpreter.interpret(notes, battery);
    const validated = guardrails.validateDirectives(directives, notes, battery);
    const mismatches = [];

    validated.forEach((entry, index) => {
      const want = expected[index];
      if (entry.directive_type !== want.directive_type) {
        mismatches.push(`note ${index}: type ${entry.directive_type} != ${want.directive_type}`);
        return;
      }
      if (want.structured_adjustment === null) return;
      const got = entry.structured_adjustment ?? {};
      if (JSON.stringify(got.hours) !== JSON.stringify(want.structured_adjustment.hours)) {
        mismatches.push(
          `note ${index}: hours ${JSON.stringify(got.hours)} != ${JSON.stringify(want.structured_adjustment.hours)}`,
        );
      }
      for (const key of ['factor', 'minimum_energy_kwh', 'max_grid_kwh']) {
        const wanted = want.structured_adjustment[key];
        if (wanted === undefined) continue;
        if (Math.abs((got[key] ?? NaN) - wanted) > TOLERANCE) {
          mismatches.push(`note ${index}: ${key} ${got[key]} != ${wanted}`);
        }
      }
    });

    return { id, ok: mismatches.length === 0, source, notes: notes.length, mismatches };
  } catch (error) {
    return { id, ok: false, source: 'error', notes: notes.length, mismatches: [error.message] };
  }
}

function report(rows) {
  console.log('\nGridWise live LLM interpretation\n');
  console.log('case        notes  source     result');
  console.log('-'.repeat(60));
  let passed = 0;
  for (const row of rows) {
    if (row.ok) passed += 1;
    console.log(
      [row.id.padEnd(11), String(row.notes).padStart(5), row.source.padEnd(10), row.ok ? 'MATCH' : 'MISMATCH'].join('  '),
    );
    for (const mismatch of row.mismatches) console.log(`            ! ${mismatch}`);
  }
  console.log('-'.repeat(60));
  console.log(`${passed}/${rows.length} cases match ground truth\n`);
  process.exitCode = passed === rows.length ? 0 : 1;
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function loadDotEnv() {
  try {
    const text = readFileSync(resolve(ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // No .env file - rely on the real environment.
  }
}
