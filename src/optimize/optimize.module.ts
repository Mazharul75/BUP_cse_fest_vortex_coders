import { Module } from '@nestjs/common';
import { FallbackInterpreterService } from './fallback-interpreter.service';
import { GuardrailsService } from './guardrails.service';
import { InterpreterService } from './interpreter.service';
import { OptimizeController } from './optimize.controller';
import { OptimizeService } from './optimize.service';
import { OptimizerService } from './optimizer.service';
import { VerifierService } from './verifier.service';

@Module({
  controllers: [OptimizeController],
  providers: [
    OptimizeService,
    InterpreterService,
    FallbackInterpreterService,
    GuardrailsService,
    OptimizerService,
    VerifierService,
  ],
})
export class OptimizeModule {}
