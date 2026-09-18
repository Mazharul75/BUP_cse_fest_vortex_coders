import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { GlobalExceptionFilter } from '../../src/common/http-exception.filter';
import { InterpreterService } from '../../src/optimize/interpreter.service';

const pack = JSON.parse(
  readFileSync(resolve(__dirname, '../../sample-cases/public-sample-cases.json'), 'utf8'),
);

const TOL = 0.01;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * Full-stack HTTP tests. The language model is replaced by a stub that replays the
 * published ground truth, so the suite is deterministic, needs no API key, and still
 * exercises every other layer: pipe, controller, guardrails, optimizer, verifier,
 * response assembly and the error filter.
 */
describe('GridWise API (e2e)', () => {
  let app: INestApplication;
  let interpret: jest.Mock;

  beforeAll(async () => {
    interpret = jest.fn();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(InterpreterService)
      .useValue({ interpret, isConfigured: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useLogger(false);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    interpret.mockReset();
  });

  function useGroundTruth(index: number) {
    interpret.mockResolvedValue({
      directives: clone(pack.cases[index].expected_output.directive_interpretation),
      source: 'llm',
    });
  }

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const response = await request(app.getHttpServer()).get('/health').expect(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('stays available after a failed optimize request', async () => {
      interpret.mockRejectedValueOnce(new Error('boom'));
      await request(app.getHttpServer()).post('/optimize-energy').send({}).expect(400);
      await request(app.getHttpServer()).get('/health').expect(200);
    });
  });

  describe('POST /optimize-energy - contract', () => {
    it('answers every public sample case with a valid, correctly-costed plan', async () => {
      for (let index = 0; index < pack.cases.length; index += 1) {
        useGroundTruth(index);
        const input = clone(pack.cases[index].input);
        const response = await request(app.getHttpServer())
          .post('/optimize-energy')
          .send(input)
          .expect(200);

        const body = response.body;
        expect(body.scenario_id).toBe(input.scenario_id);
        expect(body.hourly_plan).toHaveLength(24);
        expect(body.directive_interpretation).toHaveLength(input.operator_notes.length);

        // Totals recalculated from hourly_plan, as the judge does.
        const tariff = new Map<number, number>(
          input.hours.map((h: any) => [h.hour as number, h.tariff_bdt_per_kwh as number]),
        );
        const grid = body.hourly_plan.reduce((s: number, e: any) => s + e.grid_kwh, 0);
        const cost = body.hourly_plan.reduce(
          (s: number, e: any) => s + e.grid_kwh * (tariff.get(e.hour) ?? 0),
          0,
        );
        expect(Math.abs(grid - body.total_grid_kwh)).toBeLessThanOrEqual(TOL);
        expect(Math.abs(cost - body.total_cost_bdt)).toBeLessThanOrEqual(TOL);
        expect(body.total_cost_bdt).toBeLessThanOrEqual(
          pack.cases[index].expected_output.total_cost_bdt + TOL,
        );

        // Energy balance and end-of-day neutrality.
        let energy = input.battery.initial_energy_kwh;
        body.hourly_plan.forEach((entry: any, hour: number) => {
          expect(entry.hour).toBe(hour);
          const charge = entry.battery_action === 'charge' ? entry.battery_kwh : 0;
          const discharge = entry.battery_action === 'discharge' ? entry.battery_kwh : 0;
          const balance =
            entry.grid_kwh + entry.solar_used_kwh + discharge - (input.hours[hour].demand_kwh + charge);
          expect(Math.abs(balance)).toBeLessThanOrEqual(TOL);
          energy += charge - discharge;
        });
        expect(Math.abs(energy - input.battery.initial_energy_kwh)).toBeLessThanOrEqual(TOL);
      }
    });

    it('returns directive entries in note_index order with correct applies semantics', async () => {
      useGroundTruth(9);
      const response = await request(app.getHttpServer())
        .post('/optimize-energy')
        .send(clone(pack.cases[9].input))
        .expect(200);

      response.body.directive_interpretation.forEach((entry: any, index: number) => {
        expect(entry.note_index).toBe(index);
        expect(Object.keys(entry).sort()).toEqual([
          'applies',
          'directive_type',
          'explanation',
          'note_index',
          'structured_adjustment',
        ]);
        if (entry.directive_type === 'no_op') {
          expect(entry.applies).toBe(false);
          expect(entry.structured_adjustment).toBeNull();
        } else {
          expect(entry.applies).toBe(true);
          expect(entry.structured_adjustment).not.toBeNull();
          const hours = entry.structured_adjustment.hours;
          expect(hours).toEqual([...new Set(hours)].sort((a: any, b: any) => a - b));
        }
      });
    });

    it('accepts a single-note scenario', async () => {
      useGroundTruth(1);
      await request(app.getHttpServer())
        .post('/optimize-energy')
        .send(clone(pack.cases[1].input))
        .expect(200);
    });
  });

  describe('POST /optimize-energy - request validation', () => {
    const bad = (body: unknown, status: number) =>
      request(app.getHttpServer()).post('/optimize-energy').send(body as any).expect(status);

    beforeEach(() => useGroundTruth(0));

    it('rejects malformed JSON with 400', async () => {
      await request(app.getHttpServer())
        .post('/optimize-energy')
        .set('content-type', 'application/json')
        .send('{"scenario_id": ')
        .expect(400);
    });

    it('rejects an empty body with 400', () => bad({}, 400));

    it('rejects more than three operator notes with 400', () => {
      const input = clone(pack.cases[0].input);
      input.operator_notes = ['a', 'b', 'c', 'd'];
      return bad(input, 400);
    });

    it('rejects zero operator notes with 400', () => {
      const input = clone(pack.cases[0].input);
      input.operator_notes = [];
      return bad(input, 400);
    });

    it('rejects an empty note string with 400', () => {
      const input = clone(pack.cases[0].input);
      input.operator_notes = ['   '];
      return bad(input, 400);
    });

    it('rejects a short hours array with 400', () => {
      const input = clone(pack.cases[0].input);
      input.hours = input.hours.slice(0, 23);
      return bad(input, 400);
    });

    it('rejects a missing battery object with 400', () => {
      const input = clone(pack.cases[0].input);
      delete input.battery;
      return bad(input, 400);
    });

    it('rejects a negative demand value with 400', () => {
      const input = clone(pack.cases[0].input);
      input.hours[3].demand_kwh = -10;
      return bad(input, 400);
    });

    it('rejects a duplicated hour with 422', () => {
      const input = clone(pack.cases[0].input);
      input.hours[5].hour = 4;
      return bad(input, 422);
    });

    it('strips unknown top-level fields instead of failing', async () => {
      const input = { ...clone(pack.cases[0].input), debug_mode: true };
      await request(app.getHttpServer()).post('/optimize-energy').send(input).expect(200);
    });
  });

  describe('POST /optimize-energy - failure handling', () => {
    it('returns 422 with a controlled body when no feasible schedule exists', async () => {
      const input = clone(pack.cases[0].input);
      interpret.mockResolvedValue({
        directives: [
          {
            note_index: 0,
            applies: true,
            directive_type: 'minimum_battery_reserve',
            structured_adjustment: { hours: [1], minimum_energy_kwh: input.battery.capacity_kwh },
            explanation: 'x',
          },
          {
            note_index: 1,
            applies: true,
            directive_type: 'no_charge_window',
            structured_adjustment: { hours: [...Array(24).keys()] },
            explanation: 'x',
          },
        ],
        source: 'llm',
      });

      const response = await request(app.getHttpServer())
        .post('/optimize-energy')
        .send(input)
        .expect(422);
      expect(response.body).toEqual({ error: 'No feasible schedule found' });
    });

    it('degrades to the deterministic interpreter when the model throws', async () => {
      interpret.mockImplementation(() => {
        throw new TypeError('unexpected internal failure');
      });
      const response = await request(app.getHttpServer())
        .post('/optimize-energy')
        .send(clone(pack.cases[1].input))
        .expect(200);
      expect(response.body.hourly_plan).toHaveLength(24);
      expect(response.body.directive_interpretation[0].directive_type).toBe('no_charge_window');
    });

    it('degrades when the model returns an invented directive type', async () => {
      interpret.mockResolvedValue({
        directives: [{ note_index: 0, directive_type: 'shed_load', structured_adjustment: {} }],
        source: 'llm',
      });
      const response = await request(app.getHttpServer())
        .post('/optimize-energy')
        .send(clone(pack.cases[1].input))
        .expect(200);
      expect(response.body.directive_interpretation[0].directive_type).toBe('no_charge_window');
    });

    it('never leaks a stack trace or a credential in any response', async () => {
      interpret.mockImplementation(() => {
        throw new Error('auth failed for key=AIzaSyTOPSECRETVALUE12345');
      });
      const responses = await Promise.all([
        request(app.getHttpServer()).post('/optimize-energy').send(clone(pack.cases[1].input)),
        request(app.getHttpServer()).post('/optimize-energy').send({}),
        request(app.getHttpServer()).get('/nope'),
      ]);
      for (const response of responses) {
        const text = JSON.stringify(response.body);
        expect(text).not.toMatch(/AIzaSy/);
        expect(text).not.toMatch(/key=/);
        expect(text).not.toMatch(/\bat \w+ \(/);
        expect(text).not.toMatch(/\.ts:\d+/);
      }
    });

    it('stays stable across repeated requests', async () => {
      useGroundTruth(3);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await request(app.getHttpServer())
          .post('/optimize-energy')
          .send(clone(pack.cases[3].input))
          .expect(200);
      }
    });

    it('handles concurrent requests', async () => {
      useGroundTruth(4);
      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          request(app.getHttpServer()).post('/optimize-energy').send(clone(pack.cases[4].input)),
        ),
      );
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.body.hourly_plan).toHaveLength(24);
      }
    });

    it('returns 404 for an unknown route', () =>
      request(app.getHttpServer()).get('/optimise-energy').expect(404));
  });
});
