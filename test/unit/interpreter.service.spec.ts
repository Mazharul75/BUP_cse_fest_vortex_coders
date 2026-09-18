import { ConfigService } from '@nestjs/config';
import { InterpreterError } from '../../src/common/errors';
import { BatteryDto } from '../../src/optimize/dto/optimize-request.dto';
import { InterpreterService } from '../../src/optimize/interpreter.service';
import {
  INTERPRETER_SYSTEM_PROMPT,
  buildInterpreterUserPrompt,
} from '../../src/optimize/interpreter.prompt';

const battery: BatteryDto = {
  capacity_kwh: 200,
  initial_energy_kwh: 100,
  minimum_energy_kwh: 40,
  max_charge_kwh_per_hour: 50,
  max_discharge_kwh_per_hour: 50,
};

function makeService(env: Record<string, string> = {}): InterpreterService {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const service = new InterpreterService(config);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  return service;
}

const VALID_ENTRY = {
  note_index: 0,
  applies: true,
  directive_type: 'solar_reduction',
  structured_adjustment: { hours: [13, 14], factor: 0.2 },
  explanation: 'reduced',
};

describe('InterpreterService', () => {
  describe('configuration', () => {
    it('reports unconfigured when no key is present', () => {
      const service = makeService();
      service.onModuleInit();
      expect(service.isConfigured()).toBe(false);
    });

    it('comes up configured with a single key', () => {
      const service = makeService({ GEMINI_API_KEY: 'test-key' });
      service.onModuleInit();
      expect(service.isConfigured()).toBe(true);
      expect(service['clients']).toHaveLength(1);
    });

    it('rotates across several keys', () => {
      const service = makeService({ GEMINI_API_KEYS: 'a, b ,c' });
      service.onModuleInit();
      expect(service['clients']).toHaveLength(3);
      const first = service['nextClient']();
      const second = service['nextClient']();
      const third = service['nextClient']();
      expect(service['nextClient']()).toBe(first);
      expect(new Set([first, second, third]).size).toBe(3);
    });

    it('builds a model fallback chain without duplicates', () => {
      const service = makeService({
        GEMINI_MODEL: 'gemini-2.5-flash',
        GEMINI_FALLBACK_MODELS: 'gemini-2.5-flash,gemini-2.0-flash',
      });
      expect(service['models']).toEqual(['gemini-2.5-flash', 'gemini-2.0-flash']);
    });

    it('fails the request, not the process, when no key is configured', async () => {
      const service = makeService();
      service.onModuleInit();
      await expect(service.interpret(['a note'], battery)).rejects.toBeInstanceOf(InterpreterError);
    });
  });

  describe('response parsing', () => {
    const parse = (raw: string) => makeService()['parseDirectiveArray'](raw);

    it('parses a bare JSON array', () => {
      expect(parse(JSON.stringify([VALID_ENTRY]))).toHaveLength(1);
    });

    it('strips a markdown fence', () => {
      expect(parse('```json\n' + JSON.stringify([VALID_ENTRY]) + '\n```')).toHaveLength(1);
    });

    it('strips an unlabelled fence', () => {
      expect(parse('```\n' + JSON.stringify([VALID_ENTRY]) + '\n```')).toHaveLength(1);
    });

    it('unwraps a named wrapper object', () => {
      for (const key of ['directive_interpretation', 'directives', 'interpretations', 'result']) {
        expect(parse(JSON.stringify({ [key]: [VALID_ENTRY] }))).toHaveLength(1);
      }
    });

    it('recovers an array embedded in prose', () => {
      expect(parse(`Here you go: ${JSON.stringify([VALID_ENTRY])} - hope that helps.`)).toHaveLength(1);
    });

    it('throws on unparseable output rather than inventing a directive', () => {
      expect(() => parse('I could not determine the directive.')).toThrow(InterpreterError);
      expect(() => parse('[{"note_index": 0,')).toThrow(InterpreterError);
      expect(() => parse('')).toThrow(InterpreterError);
    });

    it('throws when the payload is an object with no directive array', () => {
      expect(() => parse(JSON.stringify({ status: 'ok' }))).toThrow(InterpreterError);
    });
  });

  describe('retry, caching and failure classification', () => {
    it('retries and succeeds on a later attempt', async () => {
      const service = makeService({ GEMINI_API_KEY: 'k' });
      service.onModuleInit();
      const call = jest
        .spyOn(service as any, 'callModel')
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce(JSON.stringify([VALID_ENTRY]));

      const result = await service.interpret(['a note'], battery);
      expect(result.source).toBe('llm');
      expect(call).toHaveBeenCalledTimes(2);
    });

    it('gives up with InterpreterError after the attempt budget', async () => {
      const service = makeService({ GEMINI_API_KEY: 'k', LLM_MAX_ATTEMPTS: '2' } as any);
      service.onModuleInit();
      jest.spyOn(service as any, 'callModel').mockRejectedValue(new Error('always down'));
      await expect(service.interpret(['a note'], battery)).rejects.toBeInstanceOf(InterpreterError);
    });

    it('serves a repeated scenario from cache without calling the model again', async () => {
      const service = makeService({ GEMINI_API_KEY: 'k' });
      service.onModuleInit();
      const call = jest
        .spyOn(service as any, 'callModel')
        .mockResolvedValue(JSON.stringify([VALID_ENTRY]));

      const first = await service.interpret(['a note'], battery);
      const second = await service.interpret(['a note'], battery);
      expect(first.source).toBe('llm');
      expect(second.source).toBe('llm-cache');
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('does not reuse a cache entry across different notes', async () => {
      const service = makeService({ GEMINI_API_KEY: 'k' });
      service.onModuleInit();
      const call = jest
        .spyOn(service as any, 'callModel')
        .mockResolvedValue(JSON.stringify([VALID_ENTRY]));
      await service.interpret(['note one'], battery);
      await service.interpret(['note two'], battery);
      expect(call).toHaveBeenCalledTimes(2);
    });

    it('uses the next model in the chain on a retry', async () => {
      const service = makeService({
        GEMINI_API_KEY: 'k',
        GEMINI_MODEL: 'model-a',
        GEMINI_FALLBACK_MODELS: 'model-b',
      });
      service.onModuleInit();
      const call = jest
        .spyOn(service as any, 'callModel')
        .mockRejectedValueOnce(Object.assign(new Error('429 quota'), { status: 429 }))
        .mockResolvedValueOnce(JSON.stringify([VALID_ENTRY]));

      await service.interpret(['a note'], battery);
      expect(call.mock.calls[0][1]).toBe('model-a');
      expect(call.mock.calls[1][1]).toBe('model-b');
    });

    it('classifies rate limiting as throttled and backs off longer', () => {
      const describe429 = makeService()['describe'](
        Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }),
      );
      expect(describe429.throttled).toBe(true);
      const describeParse = makeService()['describe'](new InterpreterError('bad json'));
      expect(describeParse.throttled).toBe(false);
    });

    it('redacts credentials from a logged provider message', () => {
      const detail = makeService()['describe'](
        new Error('failed for key=AIzaSyABCDEFGHIJKLMNOPQRS and AQ.Ab8RN6LcSECRETVALUE123'),
      );
      expect(detail.message).not.toMatch(/AIzaSy[A-Za-z]/);
      expect(detail.message).not.toMatch(/SECRETVALUE/);
      expect(detail.message).toMatch(/\[redacted\]/);
    });

    it('times out a slow model call', async () => {
      const service = makeService({ GEMINI_API_KEY: 'k' });
      service.onModuleInit();
      const never = new Promise(() => undefined);
      await expect(service['withTimeout'](never as any, 30)).rejects.toBeInstanceOf(InterpreterError);
    });
  });

  describe('prompt', () => {
    it('states the six directive types and nothing else', () => {
      for (const type of [
        'solar_reduction',
        'minimum_battery_reserve',
        'no_charge_window',
        'no_discharge_window',
        'max_grid_window',
        'no_op',
      ]) {
        expect(INTERPRETER_SYSTEM_PROMPT).toContain(type);
      }
    });

    it('states the end-exclusive window rule and the remaining-fraction rule', () => {
      expect(INTERPRETER_SYSTEM_PROMPT).toContain('[13, 14]');
      expect(INTERPRETER_SYSTEM_PROMPT).toMatch(/80% reduction.*0\.2/s);
    });

    it('gives the model the battery data it needs for share-of-capacity notes', () => {
      const prompt = buildInterpreterUserPrompt(['Keep half the battery in reserve.'], {
        capacity_kwh: 200,
        initial_energy_kwh: 100,
        minimum_energy_kwh: 40,
        max_charge_kwh_per_hour: 50,
        max_discharge_kwh_per_hour: 50,
      });
      expect(prompt).toContain('"capacity_kwh":200');
      expect(prompt).toContain('0: Keep half the battery in reserve.');
    });

    it('numbers every note for the model', () => {
      const prompt = buildInterpreterUserPrompt(['a', 'b', 'c'], { capacity_kwh: 1 } as any);
      expect(prompt).toContain('0: a');
      expect(prompt).toContain('2: c');
      expect(prompt).toContain('note_index 0 through 2');
    });
  });
});
