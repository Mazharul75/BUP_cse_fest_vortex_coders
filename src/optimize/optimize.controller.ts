import { Body, Controller, HttpCode, Post, UnprocessableEntityException } from '@nestjs/common';
import { HOURS_IN_DAY } from './constants';
import { OptimizeRequestDto } from './dto/optimize-request.dto';
import { OptimizeResponse } from './dto/optimize-response.dto';
import { OptimizeService } from './optimize.service';

@Controller()
export class OptimizeController {
  constructor(private readonly optimizeService: OptimizeService) {}

  /**
   * Structural request validation is handled by the global ValidationPipe, which
   * returns HTTP 400 for a malformed or structurally invalid body. Semantic failures
   * (guardrails, infeasible schedule) surface as HTTP 422 through the global filter;
   * anything unexpected becomes a controlled HTTP 500 with no internal detail.
   */
  @Post('optimize-energy')
  @HttpCode(200)
  async optimizeEnergy(@Body() body: OptimizeRequestDto): Promise<OptimizeResponse> {
    this.assertCompleteDay(body);
    return this.optimizeService.optimizeEnergy(body);
  }

  /** The 24 hour entries must cover 0 through 23 exactly once each. */
  private assertCompleteDay(body: OptimizeRequestDto): void {
    const seen = new Set(body.hours.map((entry) => entry.hour));
    if (seen.size !== HOURS_IN_DAY) {
      throw new UnprocessableEntityException({
        error: 'hours must contain each hour from 0 to 23 exactly once',
      });
    }
  }
}
