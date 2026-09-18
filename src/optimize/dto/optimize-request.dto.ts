import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const FINITE = { allowNaN: false, allowInfinity: false } as const;

export class HourEntryDto {
  @IsInt()
  @Min(0)
  @Max(23)
  hour: number;

  @IsNumber(FINITE)
  @Min(0)
  demand_kwh: number;

  @IsNumber(FINITE)
  @Min(0)
  solar_kwh: number;

  @IsNumber(FINITE)
  @Min(0)
  tariff_bdt_per_kwh: number;
}

export class BatteryDto {
  @IsNumber(FINITE)
  @Min(0)
  capacity_kwh: number;

  @IsNumber(FINITE)
  @Min(0)
  initial_energy_kwh: number;

  @IsNumber(FINITE)
  @Min(0)
  minimum_energy_kwh: number;

  @IsNumber(FINITE)
  @Min(0)
  max_charge_kwh_per_hour: number;

  @IsNumber(FINITE)
  @Min(0)
  max_discharge_kwh_per_hour: number;
}

export class OptimizeRequestDto {
  @IsString()
  @IsNotEmpty()
  scenario_id: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  // A whitespace-only note is not a natural-language note.
  @Matches(/\S/, { each: true, message: 'each operator note must contain text' })
  operator_notes: string[];

  @IsArray()
  @ArrayMinSize(24)
  @ArrayMaxSize(24)
  @ValidateNested({ each: true })
  @Type(() => HourEntryDto)
  hours: HourEntryDto[];

  @IsDefined()
  @ValidateNested()
  @Type(() => BatteryDto)
  battery: BatteryDto;
}
