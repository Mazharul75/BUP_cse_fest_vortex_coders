import { DirectiveValidationError } from '../../src/common/errors';
import { BatteryDto } from '../../src/optimize/dto/optimize-request.dto';
import { GuardrailsService } from '../../src/optimize/guardrails.service';

const battery: BatteryDto = {
  capacity_kwh: 200,
  initial_energy_kwh: 100,
  minimum_energy_kwh: 40,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
};

const notes = ['note a', 'note b'];

describe('GuardrailsService', () => {
  let guardrails: GuardrailsService;

  beforeEach(() => {
    guardrails = new GuardrailsService();
    jest.spyOn(guardrails['logger'], 'warn').mockImplementation(() => undefined);
  });

  const solar = (over: Record<string, unknown> = {}) => ({
    note_index: 0,
    applies: true,
    directive_type: 'solar_reduction',
    structured_adjustment: { hours: [13, 14], factor: 0.2 },
    explanation: 'reduced solar',
    ...over,
  });

  const noOp = (over: Record<string, unknown> = {}) => ({
    note_index: 1,
    applies: false,
    directive_type: 'no_op',
    structured_adjustment: null,
    explanation: 'irrelevant',
    ...over,
  });

  describe('accepts well-formed output', () => {
    it('passes a valid pair through unchanged', () => {
      const result = guardrails.validateDirectives([solar(), noOp()], notes, battery);
      expect(result).toHaveLength(2);
      expect(result[0].directive_type).toBe('solar_reduction');
      expect(result[0].structured_adjustment).toEqual({ hours: [13, 14], factor: 0.2 });
      expect(result[1].applies).toBe(false);
      expect(result[1].structured_adjustment).toBeNull();
    });

    it('accepts every supported directive type', () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['solar_reduction', { hours: [1], factor: 0.5 }],
        ['minimum_battery_reserve', { hours: [18], minimum_energy_kwh: 120 }],
        ['no_charge_window', { hours: [2, 3] }],
        ['no_discharge_window', { hours: [4] }],
        ['max_grid_window', { hours: [19], max_grid_kwh: 150 }],
      ];
      for (const [type, adjustment] of cases) {
        const result = guardrails.validateDirectives(
          [{ note_index: 0, applies: true, directive_type: type, structured_adjustment: adjustment, explanation: 'x' }],
          ['single note'],
          battery,
        );
        expect(result[0].directive_type).toBe(type);
        expect(result[0].structured_adjustment).toEqual(adjustment);
      }
    });
  });

  describe('repairs recoverable deviations', () => {
    it('sorts and deduplicates hours', () => {
      const result = guardrails.validateDirectives(
        [solar({ structured_adjustment: { hours: [14, 13, 14, 13], factor: 0.2 } }), noOp()],
        notes,
        battery,
      );
      expect((result[0].structured_adjustment as any).hours).toEqual([13, 14]);
    });

    it('reads a percentage written as a whole number', () => {
      const result = guardrails.validateDirectives(
        [solar({ structured_adjustment: { hours: [13], factor: 20 } }), noOp()],
        notes,
        battery,
      );
      expect((result[0].structured_adjustment as any).factor).toBeCloseTo(0.2, 6);
    });

    it('clamps a factor above 1 and below 0', () => {
      const high = guardrails.validateDirectives(
        [solar({ structured_adjustment: { hours: [13], factor: 140 } }), noOp()],
        notes,
        battery,
      );
      expect((high[0].structured_adjustment as any).factor).toBe(1);

      const low = guardrails.validateDirectives(
        [solar({ structured_adjustment: { hours: [13], factor: -3 } }), noOp()],
        notes,
        battery,
      );
      expect((low[0].structured_adjustment as any).factor).toBe(0);
    });

    it('clamps a reserve above battery capacity', () => {
      const result = guardrails.validateDirectives(
        [
          {
            note_index: 0,
            applies: true,
            directive_type: 'minimum_battery_reserve',
            structured_adjustment: { hours: [18], minimum_energy_kwh: 9999 },
            explanation: 'x',
          },
        ],
        ['single'],
        battery,
      );
      expect((result[0].structured_adjustment as any).minimum_energy_kwh).toBe(battery.capacity_kwh);
    });

    it('clamps a negative grid cap to zero', () => {
      const result = guardrails.validateDirectives(
        [
          {
            note_index: 0,
            applies: true,
            directive_type: 'max_grid_window',
            structured_adjustment: { hours: [19], max_grid_kwh: -5 },
            explanation: 'x',
          },
        ],
        ['single'],
        battery,
      );
      expect((result[0].structured_adjustment as any).max_grid_kwh).toBe(0);
    });

    it('drops unsupported fields from structured_adjustment', () => {
      const result = guardrails.validateDirectives(
        [solar({ structured_adjustment: { hours: [13], factor: 0.2, confidence: 0.9, note: 'hi' } }), noOp()],
        notes,
        battery,
      );
      expect(Object.keys(result[0].structured_adjustment as object).sort()).toEqual(['factor', 'hours']);
    });

    it('forces applies to match the directive type', () => {
      const result = guardrails.validateDirectives(
        [solar({ applies: false }), noOp({ applies: true, structured_adjustment: { hours: [1] } })],
        notes,
        battery,
      );
      expect(result[0].applies).toBe(true);
      expect(result[1].applies).toBe(false);
      expect(result[1].structured_adjustment).toBeNull();
    });

    it('normalises directive_type casing and spacing', () => {
      const result = guardrails.validateDirectives(
        [solar({ directive_type: ' Solar-Reduction ' }), noOp()],
        notes,
        battery,
      );
      expect(result[0].directive_type).toBe('solar_reduction');
    });

    it('reorders entries returned out of note_index order', () => {
      const result = guardrails.validateDirectives(
        [noOp({ note_index: 1 }), solar({ note_index: 0 })],
        notes,
        battery,
      );
      expect(result.map((entry) => entry.note_index)).toEqual([0, 1]);
      expect(result[0].directive_type).toBe('solar_reduction');
    });

    it('falls back to array position when note_index is missing', () => {
      const result = guardrails.validateDirectives(
        [solar({ note_index: undefined }), noOp({ note_index: undefined })],
        notes,
        battery,
      );
      expect(result.map((entry) => entry.note_index)).toEqual([0, 1]);
    });

    it('substitutes an explanation when the model omits one', () => {
      const result = guardrails.validateDirectives(
        [solar({ explanation: '   ' }), noOp({ explanation: null })],
        notes,
        battery,
      );
      expect(result[0].explanation.length).toBeGreaterThan(0);
      expect(result[1].explanation.length).toBeGreaterThan(0);
    });
  });

  describe('rejects output that cannot be trusted', () => {
    const rejects = (raw: unknown, noteList = notes) =>
      expect(() => guardrails.validateDirectives(raw, noteList, battery)).toThrow(
        DirectiveValidationError,
      );

    it('rejects a non-array', () => rejects({ directives: [] }));
    it('rejects the wrong entry count', () => rejects([solar()]));
    it('rejects an invented directive type', () =>
      rejects([solar({ directive_type: 'shed_load' }), noOp()]));
    it('rejects duplicate note_index values', () =>
      rejects([solar({ note_index: 0 }), noOp({ note_index: 0 })]));
    it('rejects an hour outside 0-23', () =>
      rejects([solar({ structured_adjustment: { hours: [24], factor: 0.2 } }), noOp()]));
    it('rejects a non-integer hour', () =>
      rejects([solar({ structured_adjustment: { hours: [13.5], factor: 0.2 } }), noOp()]));
    it('rejects an empty hours array', () =>
      rejects([solar({ structured_adjustment: { hours: [], factor: 0.2 } }), noOp()]));
    it('rejects a missing hours array', () =>
      rejects([solar({ structured_adjustment: { factor: 0.2 } }), noOp()]));
    it('rejects a null adjustment on an applying directive', () =>
      rejects([solar({ structured_adjustment: null }), noOp()]));
    it('rejects a non-numeric factor', () =>
      rejects([solar({ structured_adjustment: { hours: [13], factor: 'low' } }), noOp()]));
    it('rejects a missing required numeric field', () =>
      rejects([
        {
          note_index: 0,
          applies: true,
          directive_type: 'max_grid_window',
          structured_adjustment: { hours: [19] },
          explanation: 'x',
        },
        noOp(),
      ]));
    it('rejects a non-object entry', () => rejects(['solar_reduction', noOp()]));
  });
});
