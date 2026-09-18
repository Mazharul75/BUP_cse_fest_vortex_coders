/**
 * Controlled error types. Every one of these is mapped to a safe JSON response by
 * GlobalExceptionFilter - no stack traces, no provider messages, no secrets.
 */

/** LLM output failed deterministic guardrail validation (Problem Statement 08). */
export class DirectiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectiveValidationError';
  }
}

/** The optimizer could not find a schedule satisfying every hard constraint. */
export class InfeasibleScheduleError extends Error {
  constructor(message = 'No feasible schedule found') {
    super(message);
    this.name = 'InfeasibleScheduleError';
  }
}

/** The language model could not be reached or returned unusable output. */
export class InterpreterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpreterError';
  }
}

/** The produced schedule failed the post-optimization replay (Problem Statement 08). */
export class ReplayVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayVerificationError';
  }
}
