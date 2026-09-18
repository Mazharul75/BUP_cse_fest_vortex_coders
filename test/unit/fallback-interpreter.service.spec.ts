import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BatteryDto } from '../../src/optimize/dto/optimize-request.dto';
import { FallbackInterpreterService } from '../../src/optimize/fallback-interpreter.service';
import { GuardrailsService } from '../../src/optimize/guardrails.service';

const battery: BatteryDto = {
  capacity_kwh: 200,
  initial_energy_kwh: 100,
  minimum_energy_kwh: 40,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
};

describe('FallbackInterpreterService (failure path only)', () => {
  let fallback: FallbackInterpreterService;
  let guardrails: GuardrailsService;

  beforeEach(() => {
    fallback = new FallbackInterpreterService();
    guardrails = new GuardrailsService();
    jest.spyOn(fallback['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(guardrails['logger'], 'warn').mockImplementation(() => undefined);
  });

  const read = (note: string) => fallback.interpret([note], battery)[0] as any;

  describe('time windows', () => {
    const cases: Array<[string, number[]]> = [
      ['Do not charge the battery from 2 AM until 5 AM.', [2, 3, 4]],
      ['Do not charge the battery between 2 PM and 4 PM.', [14, 15]],
      ['Battery charging is disabled from 11 AM until 1 PM.', [11, 12]],
      ['Do not discharge the battery from 6 PM until 9 PM.', [18, 19, 20]],
      ['Charging is unavailable from 13:00 to 15:00.', [13, 14]],
    ];
    it.each(cases)('parses %s', (note, expected) => {
      expect(read(note).structured_adjustment.hours).toEqual(expected);
    });

    it('returns hours ascending, unique, and inside 0-23', () => {
      const hours = read('Do not charge the battery from 10 PM until 2 AM.').structured_adjustment.hours;
      expect(hours).toEqual([...new Set(hours)].sort((a: number, b: number) => a - b));
      expect(Math.min(...hours)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...hours)).toBeLessThanOrEqual(23);
    });
  });

  describe('solar factor', () => {
    const cases: Array<[string, number]> = [
      ['Expect an 80% reduction in rooftop solar between 11 AM and 2 PM.', 0.2],
      ['Solar output will drop to about 20% from 1 PM to 3 PM.', 0.2],
      ['Panel washing from noon until 2 PM leaves roughly one-fifth of normal solar output.', 0.2],
      ['Cloud cover will leave about half of the forecast solar from 10 AM until noon.', 0.5],
      ['Usable solar should be treated as a quarter of the forecast from noon until 2 PM.', 0.25],
    ];
    it.each(cases)('reads the remaining fraction from %s', (note, expected) => {
      const entry = read(note);
      expect(entry.directive_type).toBe('solar_reduction');
      expect(entry.structured_adjustment.factor).toBeCloseTo(expected, 6);
    });
  });

  describe('directive selection', () => {
    it('picks no_discharge_window over no_charge_window', () => {
      expect(read('Do not discharge the battery from 5 PM until 7 PM.').directive_type).toBe(
        'no_discharge_window',
      );
    });

    it('recognises a charger outage', () => {
      expect(read('The battery charger will be isolated from 2 AM until 5 AM.').directive_type).toBe(
        'no_charge_window',
      );
    });

    it('reads an absolute reserve', () => {
      const entry = read('Keep at least 90 kWh in the battery from 6 PM until 10 PM.');
      expect(entry.directive_type).toBe('minimum_battery_reserve');
      expect(entry.structured_adjustment.minimum_energy_kwh).toBe(90);
    });

    it('converts a share of capacity into kWh', () => {
      const entry = read('Keep at least 50% of the battery capacity from 6 PM until 9 PM.');
      expect(entry.structured_adjustment.minimum_energy_kwh).toBe(100);
    });

    it('reads a grid import cap', () => {
      const entry = read('Grid import must not exceed 155 kWh from 6 PM until 9 PM.');
      expect(entry.directive_type).toBe('max_grid_window');
      expect(entry.structured_adjustment.max_grid_kwh).toBe(155);
      expect(entry.structured_adjustment.hours).toEqual([18, 19, 20]);
    });
  });

  describe('distractors', () => {
    const distractors = [
      'The cafeteria menu changes tomorrow.',
      "The sports office moved next month's registration deadline.",
      'The library is extending book-return hours next week.',
      'A seminar room booking was moved to next week.',
      'The student affairs office will publish club notices tomorrow.',
    ];
    it.each(distractors)('marks "%s" as no_op', (note) => {
      const entry = read(note);
      expect(entry.directive_type).toBe('no_op');
      expect(entry.applies).toBe(false);
      expect(entry.structured_adjustment).toBeNull();
    });

    it('falls back to no_op rather than guessing when a window is missing', () => {
      expect(read('Solar output will be poor at some point.').directive_type).toBe('no_op');
    });
  });

  it('returns exactly one entry per note, in order', () => {
    const notes = ['Do not charge from 2 AM until 4 AM.', 'The menu changes tomorrow.', 'Keep at least 90 kWh from 6 PM until 8 PM.'];
    const result = fallback.interpret(notes, battery);
    expect(result).toHaveLength(3);
    expect(result.map((entry: any) => entry.note_index)).toEqual([0, 1, 2]);
  });

  it('always produces guardrail-valid output for the public sample notes', () => {
    const pack = JSON.parse(
      readFileSync(resolve(__dirname, '../../sample-cases/public-sample-cases.json'), 'utf8'),
    );
    for (const testCase of pack.cases) {
      const raw = fallback.interpret(testCase.input.operator_notes, testCase.input.battery);
      const validated = guardrails.validateDirectives(
        raw,
        testCase.input.operator_notes,
        testCase.input.battery,
      );
      // The failure path must reproduce the published ground truth on the public set.
      expect(
        validated.map((entry) => [entry.directive_type, entry.structured_adjustment]),
      ).toEqual(
        testCase.expected_output.directive_interpretation.map((entry: any) => [
          entry.directive_type,
          entry.structured_adjustment,
        ]),
      );
    }
  });
});
