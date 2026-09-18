import { ArgumentsHost, BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  DirectiveValidationError,
  InfeasibleScheduleError,
  InterpreterError,
  ReplayVerificationError,
} from '../../src/common/errors';
import { GlobalExceptionFilter } from '../../src/common/http-exception.filter';

function makeHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  const cases: Array<[string, unknown, number, Record<string, unknown>]> = [
    ['guardrail rejection', new DirectiveValidationError('bad hours'), 422, { error: 'Operator-note interpretation failed validation' }],
    ['infeasible schedule', new InfeasibleScheduleError(), 422, { error: 'No feasible schedule found' }],
    ['replay failure', new ReplayVerificationError('mismatch'), 422, { error: 'No feasible schedule found' }],
    ['interpreter failure', new InterpreterError('provider down'), 500, { error: 'Internal server error' }],
    ['unknown error', new Error('kaboom'), 500, { error: 'Internal server error' }],
    ['non-Error throw', 'a string', 500, { error: 'Internal server error' }],
  ];

  it.each(cases)('maps a %s', (_label, error, expectedStatus, expectedBody) => {
    const { host, status, json } = makeHost();
    filter.catch(error, host);
    expect(status).toHaveBeenCalledWith(expectedStatus);
    expect(json).toHaveBeenCalledWith(expectedBody);
  });

  it('keeps validation detail on a 400', () => {
    const { host, status, json } = makeHost();
    filter.catch(new BadRequestException(['scenario_id must be a string']), host);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: 'Invalid request body',
      details: ['scenario_id must be a string'],
    });
  });

  it('passes through a custom 422 message', () => {
    const { host, status, json } = makeHost();
    filter.catch(new UnprocessableEntityException({ error: 'hours must contain each hour' }), host);
    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({ error: 'hours must contain each hour' });
  });

  it('handles a 404 without leaking internals', () => {
    const { host, status, json } = makeHost();
    filter.catch(new NotFoundException(), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toMatch(/at \w+ \(/);
  });

  it('collapses an HttpException that already carries a 500 into the generic body', () => {
    const { host, json } = makeHost();
    filter.catch(new BadRequestException(['x']), host);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toMatch(/stack|\.ts:/);
  });

  it('never includes a stack trace for any error type', () => {
    for (const [, error] of cases) {
      const { host, json } = makeHost();
      filter.catch(error, host);
      expect(JSON.stringify(json.mock.calls[0][0])).not.toMatch(/\bat \w+ \(|\.ts:\d+/);
    }
  });
});
