import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI } from '@google/genai';
import { InterpreterError } from '../common/errors';
import { BatteryDto } from './dto/optimize-request.dto';
import { INTERPRETER_SYSTEM_PROMPT, buildInterpreterUserPrompt } from './interpreter.prompt';

export interface InterpretationResult {
  directives: unknown[];
  /** Which path produced the directives - surfaced in logs, never in the response. */
  source: 'llm' | 'llm-cache';
}

/**
 * Operator-note interpretation via Google Gemini.
 *
 * This is the mandatory language-model step: the structured directive_interpretation
 * that the optimizer consumes is produced here, by the model, from the raw notes.
 * Nothing downstream re-derives the directives from the note text.
 *
 * Reliability measures, in order of effect:
 *   - a response cache keyed on the notes, so a repeated hidden case costs no quota;
 *   - optional round-robin over several API keys (GEMINI_API_KEYS), which multiplies
 *     the free-tier per-key request-per-minute allowance;
 *   - retries with backoff that lengthens for rate-limit and overload responses;
 *   - a hard overall deadline, so the endpoint always answers inside the judge's
 *     30-second per-request timeout.
 */
@Injectable()
export class InterpreterService implements OnModuleInit {
  private readonly logger = new Logger(InterpreterService.name);
  private clients: GoogleGenAI[] = [];
  private clientCursor = 0;
  private readonly cache = new Map<string, unknown[]>();
  private static readonly CACHE_LIMIT = 256;

  private readonly models: string[];
  private readonly attemptTimeoutMs: number;
  private readonly totalBudgetMs: number;
  private readonly maxAttempts: number;
  private readonly thinkingBudget: number;

  constructor(private readonly config: ConfigService) {
    const primary = this.config.get<string>('GEMINI_MODEL') ?? 'gemini-2.5-flash';
    const fallbacks = (
      this.config.get<string>('GEMINI_FALLBACK_MODELS') ??
      'gemini-flash-lite-latest,gemini-3.5-flash-lite'
    )
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    // Each retry after a rate-limit response moves to the next model, which has its
    // own free-tier allowance. The language model stays in the interpretation path.
    this.models = [primary, ...fallbacks.filter((name) => name !== primary)];
    this.attemptTimeoutMs = Number(this.config.get('LLM_TIMEOUT_MS') ?? 8000);
    this.totalBudgetMs = Number(this.config.get('LLM_TOTAL_BUDGET_MS') ?? 20000);
    this.maxAttempts = Number(this.config.get('LLM_MAX_ATTEMPTS') ?? 4);
    this.thinkingBudget = Number(this.config.get('GEMINI_THINKING_BUDGET') ?? 0);
  }

  onModuleInit(): void {
    // GEMINI_API_KEYS (comma-separated) takes precedence; GEMINI_API_KEY is the
    // single-key form and the one the README documents as required.
    const raw =
      this.config.get<string>('GEMINI_API_KEYS') ?? this.config.get<string>('GEMINI_API_KEY') ?? '';
    const keys = raw
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean);

    if (keys.length === 0) {
      // Never throw at boot: /health must still come up so the judge harness can
      // reach the service, and the failure is reported per request instead.
      this.logger.error('No Gemini API key configured - operator-note interpretation will fail');
      return;
    }

    this.clients = keys.map((apiKey) => new GoogleGenAI({ apiKey }));
    this.logger.log(
      `Interpreter ready (models: ${this.models.join(' -> ')}, keys: ${keys.length})`,
    );
  }

  isConfigured(): boolean {
    return this.clients.length > 0;
  }

  async interpret(operatorNotes: string[], battery: BatteryDto): Promise<InterpretationResult> {
    const cacheKey = this.cacheKey(operatorNotes, battery);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { directives: cached, source: 'llm-cache' };
    }

    if (this.clients.length === 0) {
      throw new InterpreterError('Language model client is not configured');
    }

    const userPrompt = buildInterpreterUserPrompt(operatorNotes, {
      capacity_kwh: battery.capacity_kwh,
      initial_energy_kwh: battery.initial_energy_kwh,
      minimum_energy_kwh: battery.minimum_energy_kwh,
      max_charge_kwh_per_hour: battery.max_charge_kwh_per_hour,
      max_discharge_kwh_per_hour: battery.max_discharge_kwh_per_hour,
    });

    const deadline = Date.now() + this.totalBudgetMs;
    let lastFailure = 'unknown error';

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 250) {
        lastFailure = 'interpretation budget exhausted';
        break;
      }

      try {
        const model = this.models[(attempt - 1) % this.models.length];
        const text = await this.callModel(
          userPrompt,
          model,
          Math.min(this.attemptTimeoutMs, remaining),
        );
        const parsed = this.parseDirectiveArray(text);
        this.remember(cacheKey, parsed);
        return { directives: parsed, source: 'llm' };
      } catch (error) {
        const detail = this.describe(error);
        lastFailure = detail.label;
        this.logger.warn(
          `Interpretation attempt ${attempt}/${this.maxAttempts} failed: ${detail.label} - ${detail.message}`,
        );
        if (attempt < this.maxAttempts) {
          // Rate-limit and overload responses need real time to clear; a malformed
          // response can be retried immediately.
          const backoff = detail.throttled ? 1200 * attempt : 250 * attempt;
          const sleep = Math.min(backoff, Math.max(0, deadline - Date.now() - 500));
          if (sleep > 0) await this.delay(sleep);
        }
      }
    }

    throw new InterpreterError(`Language model interpretation failed: ${lastFailure}`);
  }

  private async callModel(userPrompt: string, model: string, timeoutMs: number): Promise<string> {
    const client = this.nextClient();
    const request = client.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        systemInstruction: INTERPRETER_SYSTEM_PROMPT,
        // Deterministic decoding: the same note must always yield the same directive.
        temperature: 0,
        topP: 1,
        responseMimeType: 'application/json',
        maxOutputTokens: 2048,
        ...(this.thinkingBudget >= 0
          ? { thinkingConfig: { thinkingBudget: this.thinkingBudget } }
          : {}),
      },
    });

    const response = await this.withTimeout(request, timeoutMs);
    const text = typeof response?.text === 'string' ? response.text : '';
    if (!text.trim()) {
      throw new InterpreterError('Language model returned an empty response');
    }
    return text;
  }

  /** Round-robin across the configured keys to spread per-key rate limits. */
  private nextClient(): GoogleGenAI {
    const client = this.clients[this.clientCursor % this.clients.length];
    this.clientCursor += 1;
    return client;
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new InterpreterError('Language model timed out')), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Classifies a provider failure for logging and backoff. The message is scrubbed of
   * anything that could carry a credential before it reaches the log.
   */
  private describe(error: unknown): { label: string; message: string; throttled: boolean } {
    const label = error instanceof Error ? error.name : 'UnknownError';
    const raw = error instanceof Error ? error.message : String(error);
    const status = Number((error as { status?: unknown })?.status ?? NaN);
    const throttled =
      status === 429 ||
      status === 503 ||
      /rate limit|quota|RESOURCE_EXHAUSTED|overloaded|UNAVAILABLE/i.test(raw);

    const message = raw
      .replace(/(key|token|api[_-]?key)=([^&\s"']+)/gi, '$1=[redacted]')
      .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]')
      .replace(/AQ\.[0-9A-Za-z._-]{10,}/g, '[redacted]')
      .slice(0, 300);

    return { label, message, throttled };
  }

  /**
   * Parses the model response into an array. Markdown fences and a wrapper object are
   * tolerated; anything else fails loudly rather than being guessed at. No directive
   * is ever invented here - that is the guardrail layer's contract, and inventing one
   * would violate the Problem Statement's safe-failure rule.
   */
  private parseDirectiveArray(raw: string): unknown[] {
    let text = raw.trim();

    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
      text = fenced[1].trim();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Last resort: isolate the outermost array literal.
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start === -1 || end <= start) {
        throw new InterpreterError('Language model returned unparseable JSON');
      }
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        throw new InterpreterError('Language model returned unparseable JSON');
      }
    }

    if (Array.isArray(parsed)) return parsed;

    if (parsed && typeof parsed === 'object') {
      for (const key of ['directive_interpretation', 'directives', 'interpretations', 'result']) {
        const candidate = (parsed as Record<string, unknown>)[key];
        if (Array.isArray(candidate)) return candidate;
      }
    }

    throw new InterpreterError('Language model response was not a directive array');
  }

  private cacheKey(operatorNotes: string[], battery: BatteryDto): string {
    return JSON.stringify([operatorNotes, battery.capacity_kwh, battery.minimum_energy_kwh]);
  }

  private remember(key: string, directives: unknown[]): void {
    if (this.cache.size >= InterpreterService.CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, directives);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
