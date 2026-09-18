import { Injectable, Logger } from '@nestjs/common';
import { HOURS_IN_DAY } from './constants';
import { BatteryDto } from './dto/optimize-request.dto';

/**
 * FAILURE-PATH ONLY.
 *
 * This deterministic interpreter is never the primary path. It runs solely when the
 * language model is unreachable or unusable after every retry, so that a provider
 * outage degrades the answer instead of taking the service down. The mandatory LLM
 * interpretation step is InterpreterService; this class exists for reliability, and
 * the README states so explicitly.
 *
 * It intentionally returns no_op rather than guessing when it cannot recognise a note.
 */
@Injectable()
export class FallbackInterpreterService {
  private readonly logger = new Logger(FallbackInterpreterService.name);

  interpret(operatorNotes: string[], battery: BatteryDto): Record<string, unknown>[] {
    this.logger.warn('Using the deterministic failure-path interpreter');
    return operatorNotes.map((note, index) => this.interpretNote(note, index, battery));
  }

  private interpretNote(note: string, index: number, battery: BatteryDto): Record<string, unknown> {
    const text = note.toLowerCase();
    const hours = this.extractHours(text);

    const noOp = {
      note_index: index,
      applies: false,
      directive_type: 'no_op',
      structured_adjustment: null,
      explanation: 'This note does not affect the current 24-hour energy schedule.',
    };

    // Order matters: "discharge" contains "charge".
    if (/(not|no|never|avoid|disabl|unavailab|prohibit|stop)[^.]*dischar|dischar[^.]*(disabl|unavailab|prohibit|not allowed|blocked)/.test(text)) {
      if (!hours.length) return noOp;
      return this.windowDirective(index, 'no_discharge_window', hours, 'Battery discharge is unavailable during the stated window.');
    }

    if (/(not|no|never|avoid|disabl|unavailab|prohibit|isolat|stop)[^.]*charg|charg(er|ing)?[^.]*(disabl|unavailab|isolat|offline|out of service|not allowed|blocked|maintenance)/.test(text)) {
      if (!hours.length) return noOp;
      return this.windowDirective(index, 'no_charge_window', hours, 'Battery charging is unavailable during the stated window.');
    }

    if (/(solar|pv|panel|photovolt|rooftop)/.test(text)) {
      const factor = this.extractFactor(text);
      if (factor === null || !hours.length) return noOp;
      return {
        note_index: index,
        applies: true,
        directive_type: 'solar_reduction',
        structured_adjustment: { hours, factor },
        explanation: `Usable solar is reduced to ${Math.round(factor * 100)}% during the stated window.`,
      };
    }

    if (/(reserve|at least|keep|remain|minimum|no lower than|not drop below)/.test(text) && /(batter|stored|storage|kwh)/.test(text)) {
      const reserve = this.extractReserve(text, battery);
      if (reserve === null || !hours.length) return noOp;
      return {
        note_index: index,
        applies: true,
        directive_type: 'minimum_battery_reserve',
        structured_adjustment: { hours, minimum_energy_kwh: reserve },
        explanation: `At least ${reserve} kWh must remain stored during the stated window.`,
      };
    }

    if (/(grid|import|intake|feeder|transformer|substation|supply)/.test(text) && /(exceed|limit|cap|at or below|no more than|not more than|maximum|max)/.test(text)) {
      const cap = this.extractKwh(text);
      if (cap === null || !hours.length) return noOp;
      return {
        note_index: index,
        applies: true,
        directive_type: 'max_grid_window',
        structured_adjustment: { hours, max_grid_kwh: cap },
        explanation: `Hourly grid import is capped at ${cap} kWh during the stated window.`,
      };
    }

    return noOp;
  }

  private windowDirective(
    index: number,
    type: string,
    hours: number[],
    explanation: string,
  ): Record<string, unknown> {
    return {
      note_index: index,
      applies: true,
      directive_type: type,
      structured_adjustment: { hours },
      explanation,
    };
  }

  // ------------------------------------------------------------- extraction ---

  private extractHours(text: string): number[] {
    if (/\b(all day|throughout the day|whole day|entire day|24 hours)\b/.test(text)) {
      return Array.from({ length: HOURS_IN_DAY }, (_, h) => h);
    }

    const range =
      text.match(/(?:from|between)\s+(.+?)\s+(?:until|till|to|through|and|-)\s+([^,.;]+)/) ??
      text.match(/(.+?)\s+(?:until|till|to|-)\s+([^,.;]+)/);

    if (range) {
      const start = this.parseClock(range[1]);
      const end = this.parseClock(range[2]);
      if (start !== null && end !== null) {
        return this.expandWindow(start, end);
      }
    }

    const onward = text.match(/(?:from|after)\s+([^,.;]+?)\s+(?:onward|onwards|on|for the rest)/);
    if (onward) {
      const start = this.parseClock(onward[1]);
      if (start !== null) return this.expandWindow(start, 0);
    }

    const single = text.match(/(?:during|at|in)\s+the\s+([^,.;]+?)\s+hour/);
    if (single) {
      const hour = this.parseClock(single[1]);
      if (hour !== null) return [hour];
    }

    return [];
  }

  private expandWindow(start: number, endExclusive: number): number[] {
    const hours: number[] = [];
    let cursor = start;
    for (let step = 0; step < HOURS_IN_DAY; step += 1) {
      if (cursor === endExclusive && step > 0) break;
      hours.push(cursor);
      cursor = (cursor + 1) % HOURS_IN_DAY;
      if (cursor === endExclusive) break;
    }
    return [...new Set(hours)].sort((a, b) => a - b);
  }

  private parseClock(fragment: string): number | null {
    const text = fragment.trim().toLowerCase();

    if (/\bnoon\b|\bmidday\b/.test(text)) return 12;
    if (/\bmidnight\b/.test(text)) return 0;

    const iso = text.match(/(\d{1,2}):(\d{2})/);
    if (iso) {
      const hour = Number(iso[1]);
      return hour >= 0 && hour < HOURS_IN_DAY ? hour : null;
    }

    const clock = text.match(/(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)?\s*$/) ?? text.match(/(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)/);
    if (clock) {
      let hour = Number(clock[1]);
      const meridiem = clock[2]?.replace(/\./g, '');
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      if (!meridiem && hour <= 12) {
        // Bare numbers in an operator note normally mean daytime.
        const contextual = /\b(morning|am)\b/.test(text) ? hour : hour <= 7 ? hour + 12 : hour;
        hour = contextual;
      }
      return hour >= 0 && hour < HOURS_IN_DAY ? hour : null;
    }

    const words: Record<string, number> = {
      one: 13, two: 14, three: 15, four: 16, five: 17, six: 18,
      seven: 19, eight: 20, nine: 21, ten: 22, eleven: 23, twelve: 12,
    };
    for (const [word, hour] of Object.entries(words)) {
      if (new RegExp(`\\b${word}\\b`).test(text)) return hour;
    }

    return null;
  }

  private extractFactor(text: string): number | null {
    const reduction = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:reduction|decrease|drop|less|lower)/) ??
      text.match(/(?:reduc\w*|down|lower\w*|cut)\s*(?:by)\s*(?:about\s*|roughly\s*|around\s*)?(\d+(?:\.\d+)?)\s*%/);
    if (reduction) {
      return this.clampFactor(1 - Number(reduction[1]) / 100);
    }

    const remaining = text.match(/(?:to|at|around|about|roughly|only|treated as)\s*(?:about\s*|roughly\s*|around\s*)?(\d+(?:\.\d+)?)\s*%/);
    if (remaining) {
      return this.clampFactor(Number(remaining[1]) / 100);
    }

    const fractions: Array<[RegExp, number]> = [
      [/\bhalf\b/, 0.5],
      [/\bone[- ]?half\b/, 0.5],
      [/\bone[- ]?third\b|\ba third\b/, 1 / 3],
      [/\bone[- ]?quarter\b|\ba quarter\b|\bone[- ]?fourth\b/, 0.25],
      [/\bone[- ]?fifth\b|\ba fifth\b/, 0.2],
      [/\bthree[- ]?quarters\b/, 0.75],
      [/\btwo[- ]?thirds\b/, 2 / 3],
      [/\bno solar\b|\boffline\b|\bnothing\b|\bzero\b/, 0],
    ];
    for (const [pattern, value] of fractions) {
      if (pattern.test(text)) return value;
    }

    return null;
  }

  private clampFactor(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }

  private extractReserve(text: string, battery: BatteryDto): number | null {
    const share = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s*(?:the\s*)?(?:battery\s*)?capacity)?/);
    if (share && /capacity|battery/.test(text)) {
      return (Number(share[1]) / 100) * battery.capacity_kwh;
    }
    if (/\bhalf\b/.test(text) && /capacity|battery/.test(text)) {
      return 0.5 * battery.capacity_kwh;
    }
    return this.extractKwh(text);
  }

  private extractKwh(text: string): number | null {
    const match = text.match(/(\d+(?:\.\d+)?)\s*kwh/);
    return match ? Number(match[1]) : null;
  }
}
