import { Controller, Get, HttpCode } from '@nestjs/common';

@Controller()
export class HealthController {
  /** Readiness probe for the judge harness (Problem Statement 06.2). */
  @Get('health')
  @HttpCode(200)
  health(): { status: string } {
    return { status: 'ok' };
  }
}
