import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module';
import { OptimizeModule } from './optimize/optimize.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), HealthModule, OptimizeModule],
})
export class AppModule {}
