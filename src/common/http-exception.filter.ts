import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import {
  DirectiveValidationError,
  InfeasibleScheduleError,
  InterpreterError,
  ReplayVerificationError,
} from './errors';

/**
 * Single exit point for every error. Guarantees that the service never crashes and
 * never leaks an API key, a provider message, or a stack trace into a response
 * (Participant Guide 08, "Secret handling").
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    // Detail is logged server-side only.
    this.logger.error(
      exception instanceof Error
        ? `${exception.name}: ${exception.message}`
        : 'Unhandled non-Error exception',
    );

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      response.status(status).json(this.normaliseHttpPayload(status, payload));
      return;
    }

    if (exception instanceof DirectiveValidationError) {
      response
        .status(HttpStatus.UNPROCESSABLE_ENTITY)
        .json({ error: 'Operator-note interpretation failed validation' });
      return;
    }

    if (exception instanceof InfeasibleScheduleError) {
      response
        .status(HttpStatus.UNPROCESSABLE_ENTITY)
        .json({ error: 'No feasible schedule found' });
      return;
    }

    if (exception instanceof ReplayVerificationError) {
      response
        .status(HttpStatus.UNPROCESSABLE_ENTITY)
        .json({ error: 'No feasible schedule found' });
      return;
    }

    if (exception instanceof InterpreterError) {
      response
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .json({ error: 'Internal server error' });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'Internal server error' });
  }

  private normaliseHttpPayload(status: number, payload: unknown): Record<string, unknown> {
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      return { error: 'Internal server error' };
    }
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      // A validation failure carries the useful detail in `message`; the generic
      // `error: "Bad Request"` that Nest adds alongside it is not worth returning.
      if (record.message !== undefined && record.message !== null) {
        return {
          error: status === HttpStatus.BAD_REQUEST ? 'Invalid request body' : 'Request rejected',
          details: record.message,
        };
      }
      if (typeof record.error === 'string') {
        return { error: record.error };
      }
    }
    return { error: 'Request rejected' };
  }
}
