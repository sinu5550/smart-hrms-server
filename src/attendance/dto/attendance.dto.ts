import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from "class-validator";
import { BreakType } from "@prisma/client";

export class CheckInDto {
  @IsString()
  @IsNotEmpty()
  qrSecret: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  deviceType?: string;

  @IsOptional()
  @IsString()
  selfieUrl?: string;
}

export class CheckOutDto {
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsString()
  address?: string;
}

export class BreakStartDto {
  @IsEnum(BreakType, {
    message: "breakType must be one of: LUNCH, PRAYER, TEA_COFFEE, SMOKE, PERSONAL, EMERGENCY",
  })
  @IsNotEmpty()
  breakType: BreakType;
}
