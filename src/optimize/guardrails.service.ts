import { Injectable, Logger } from '@nestjs/common';
import { DirectiveValidationError } from '../common/errors';
import { ADJUSTMENT_FIELDS, DIRECTIVE_TYPES, DirectiveType, HOURS_IN_DAY, roundTo } from './constants';
import { BatteryDto } from './dto/optimize-request.dto';
import { DirectiveInterpretation } from './dto/optimize-response.dto';

/**
 * Deterministic guardrails. The language model's output is untrusted structured data
 * until it passes this service (Problem Statement 08).
 *
 * Two stages:
 *   1. REPAIR   - normalise cosmetic deviations that carry no semantic risk
 *                 (unsorted or duplicated hours, "20" written for a 0.2 factor,
 *                 a reserve above capacity, stray extra fields, a wrong applies flag).
 *   2. VALIDATE - hard, non-negotiable checks. Anything still wrong throws
 *                 DirectiveValidationError. The model is never allowed to invent a
 *                 directive type, drop a note, or emit an out-of-contract shape.
 *
 * Repairs never change which directive was chosen or which hours were meant - they
 * only force already-correct semantics into the exact shape the judge harness checks.
 */
@Injectable()
export class GuardrailsService {
  private readonly logger = new Logger(GuardrailsService.name);

  validateDirectives(
    rawOutput: unknown,
    operatorNotes: string[],
    battery: BatteryDto,
  ): DirectiveInterpretation[] {
    if (!Array.isArray(rawOutput)) {
      throw new DirectiveValidationError('Interpretation output is not an array');
    }
    if (rawOutput.length !== operatorNotes.length) {
      throw new DirectiveValidationError(
        `Expected ${operatorNotes.length} interpretation entries, received ${rawOutput.length}`,
      );
    }

    const repaired = rawOutput.map((entry, position) =>
      this.repairEntry(entry, position, operatorNotes, battery),
    );

    repaired.sort((a, b) => a.note_index - b.note_index);

    // Note mapping: exactly 0, 1, ... N-1 - no gaps, no duplicates, ascending.
    repaired.forEach((entry, index) => {
      if (entry.note_index !== index) {
        throw new DirectiveValidationError(
          `note_index sequence is invalid: expected ${index}, received ${entry.note_index}`,
        );
      }
    });

    repaired.forEach((entry) => this.assertValid(entry, battery));
    return repaired;
  }

  // ---------------------------------------------------------------- repair ---

  private repairEntry(
    raw: any,
    position: number,
    operatorNotes: string[],
    battery: BatteryDto,
  ): DirectiveInterpretation {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DirectiveValidationError(`Interpretation entry ${position} is not an object`);
    }

    const noteIndex = this.repairNoteIndex(raw.note_index, position, operatorNotes.length);
    const directiveType = this.repairDirectiveType(raw.directive_type, noteIndex);

    if (directiveType === 'no_op') {
      return {
        note_index: noteIndex,
        applies: false,
        directive_type: 'no_op',
        structured_adjustment: null,
        explanation: this.repairExplanation(
          raw.explanation,
          'This note does not affect the current 24-hour energy schedule.',
        ),
      };
    }

    const adjustment = this.repairAdjustment(
      raw.structured_adjustment,
      directiveType,
      noteIndex,
      battery,
    );

    return {
      note_index: noteIndex,
      applies: true,
      directive_type: directiveType,
      structured_adjustment: adjustment as any,
      explanation: this.repairExplanation(
        raw.explanation,
        `Interpreted as a ${directiveType.replace(/_/g, ' ')} directive.`,
      ),
    };
  }

  private repairNoteIndex(value: unknown, position: number, noteCount: number): number {
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (
      typeof parsed === 'number' &&
      Number.isInteger(parsed) &&
      parsed >= 0 &&
      parsed < noteCount
    ) {
      return parsed;
    }
    // The model returned entries in order but mislabelled or omitted the index.
    this.logger.warn(`note_index missing or out of range at position ${position}; using position`);
    return position;
  }

  private repairDirectiveType(value: unknown, noteIndex: number): DirectiveType {
    if (typeof value !== 'string') {
      throw new DirectiveValidationError(`directive_type for note ${noteIndex} is not a string`);
    }
    const normalised = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if ((DIRECTIVE_TYPES as readonly string[]).includes(normalised)) {
      return normalised as DirectiveType;
    }
    throw new DirectiveValidationError(
      `Unsupported directive_type "${value}" for note ${noteIndex}`,
    );
  }

  private repairExplanation(value: unknown, fallback: string): string {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    return fallback;
  }

  private repairAdjustment(
    raw: any,
    directiveType: Exclude<DirectiveType, 'no_op'>,
    noteIndex: number,
    battery: BatteryDto,
  ): Record<string, any> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DirectiveValidationError(
        `structured_adjustment for note ${noteIndex} must be an object for ${directiveType}`,
      );
    }

    const adjustment: Record<string, any> = { hours: this.repairHours(raw.hours, noteIndex) };

    switch (directiveType) {
      case 'solar_reduction':
        adjustment.factor = this.repairFactor(raw.factor, noteIndex);
        break;
      case 'minimum_battery_reserve':
        adjustment.minimum_energy_kwh = this.repairReserve(
          raw.minimum_energy_kwh,
          noteIndex,
          battery,
        );
        break;
      case 'max_grid_window':
        adjustment.max_grid_kwh = this.repairGridCap(raw.max_grid_kwh, noteIndex);
        break;
      case 'no_charge_window':
      case 'no_discharge_window':
        break;
    }

    // Stray fields the model added are dropped rather than rejected - only the
    // contract-defined keys reach the optimizer or the response.
    const allowed = ADJUSTMENT_FIELDS[directiveType];
    for (const key of Object.keys(raw)) {
      if (!allowed.includes(key)) {
        this.logger.warn(`Dropping unsupported field "${key}" from note ${noteIndex}`);
      }
    }

    return adjustment;
  }

  private repairHours(value: unknown, noteIndex: number): number[] {
    if (!Array.isArray(value)) {
      throw new DirectiveValidationError(`hours for note ${noteIndex} must be an array`);
    }
    const cleaned = new Set<number>();
    for (const item of value) {
      const parsed = typeof item === 'string' ? Number(item) : item;
      if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
        throw new DirectiveValidationError(
          `hours for note ${noteIndex} contains a non-numeric value`,
        );
      }
      if (!Number.isInteger(parsed)) {
        throw new DirectiveValidationError(
          `hours for note ${noteIndex} contains a non-integer value`,
        );
      }
      if (parsed < 0 || parsed >= HOURS_IN_DAY) {
        throw new DirectiveValidationError(
          `hours for note ${noteIndex} contains ${parsed}, outside 0-23`,
        );
      }
      cleaned.add(parsed);
    }
    if (cleaned.size === 0) {
      throw new DirectiveValidationError(`hours for note ${noteIndex} is empty`);
    }
    // Deduplicated and ascending, as the contract requires.
    return [...cleaned].sort((a, b) => a - b);
  }

  private repairFactor(value: unknown, noteIndex: number): number {
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
      throw new DirectiveValidationError(`factor for note ${noteIndex} is not a finite number`);
    }
    // A model that answered "20" for 20% remaining is normalised, not rejected.
    let factor = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
    if (factor < 0) factor = 0;
    if (factor > 1) factor = 1;
    // Strip binary floating-point noise so the emitted factor reads as 0.2, not
    // 0.19999999999999996.
    return roundTo(factor);
  }

  private repairReserve(value: unknown, noteIndex: number, battery: BatteryDto): number {
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
      throw new DirectiveValidationError(
        `minimum_energy_kwh for note ${noteIndex} is not a finite number`,
      );
    }
    let reserve = parsed;
    if (reserve < 0) reserve = 0;
    if (reserve > battery.capacity_kwh) reserve = battery.capacity_kwh;
    return roundTo(reserve);
  }

  private repairGridCap(value: unknown, noteIndex: number): number {
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
      throw new DirectiveValidationError(
        `max_grid_kwh for note ${noteIndex} is not a finite number`,
      );
    }
    return parsed < 0 ? 0 : roundTo(parsed);
  }

  // -------------------------------------------------------------- validate ---

  private assertValid(entry: DirectiveInterpretation, battery: BatteryDto): void {
    const { note_index: i, directive_type: type, structured_adjustment: adj } = entry;

    if (!(DIRECTIVE_TYPES as readonly string[]).includes(type)) {
      throw new DirectiveValidationError(`Unsupported directive_type "${type}" for note ${i}`);
    }

    if (type === 'no_op') {
      if (entry.applies !== false || adj !== null) {
        throw new DirectiveValidationError(
          `no_op for note ${i} must use applies=false and structured_adjustment=null`,
        );
      }
      return;
    }

    if (entry.applies !== true) {
      throw new DirectiveValidationError(`Directive ${type} for note ${i} must use applies=true`);
    }
    if (adj === null || typeof adj !== 'object') {
      throw new DirectiveValidationError(`structured_adjustment for note ${i} must not be null`);
    }

    const allowed = ADJUSTMENT_FIELDS[type as Exclude<DirectiveType, 'no_op'>];
    const present = Object.keys(adj);
    for (const key of allowed) {
      if (!present.includes(key)) {
        throw new DirectiveValidationError(
          `structured_adjustment for note ${i} is missing "${key}"`,
        );
      }
    }
    for (const key of present) {
      if (!allowed.includes(key)) {
        throw new DirectiveValidationError(
          `structured_adjustment for note ${i} has unsupported field "${key}"`,
        );
      }
    }

    const hours = (adj as { hours: number[] }).hours;
    if (!Array.isArray(hours) || hours.length === 0) {
      throw new DirectiveValidationError(`hours for note ${i} must be a non-empty array`);
    }
    hours.forEach((hour, position) => {
      if (!Number.isInteger(hour) || hour < 0 || hour >= HOURS_IN_DAY) {
        throw new DirectiveValidationError(`hours for note ${i} contains an invalid hour ${hour}`);
      }
      if (position > 0 && hour <= hours[position - 1]) {
        throw new DirectiveValidationError(
          `hours for note ${i} must be unique and in ascending order`,
        );
      }
    });

    if (type === 'solar_reduction') {
      const factor = (adj as { factor: number }).factor;
      if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0 || factor > 1) {
        throw new DirectiveValidationError(`factor for note ${i} must be a number between 0 and 1`);
      }
    }

    if (type === 'minimum_battery_reserve') {
      const reserve = (adj as { minimum_energy_kwh: number }).minimum_energy_kwh;
      if (
        typeof reserve !== 'number' ||
        !Number.isFinite(reserve) ||
        reserve < 0 ||
        reserve > battery.capacity_kwh
      ) {
        throw new DirectiveValidationError(
          `minimum_energy_kwh for note ${i} must be between 0 and battery capacity`,
        );
      }
    }

    if (type === 'max_grid_window') {
      const cap = (adj as { max_grid_kwh: number }).max_grid_kwh;
      if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) {
        throw new DirectiveValidationError(
          `max_grid_kwh for note ${i} must be a finite non-negative number`,
        );
      }
    }
  }
}
