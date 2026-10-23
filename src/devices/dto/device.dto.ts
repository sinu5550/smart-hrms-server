import { IsString, IsNotEmpty, IsOptional, IsNumber, IsBoolean } from 'class-validator';

export class RegisterBiometricDeviceDto {
  @IsString()
  @IsNotEmpty()
  deviceName: string;

  @IsString()
  @IsNotEmpty()
  deviceSerialNumber: string;

  @IsString()
  @IsOptional()
  deviceModel?: string;

  @IsString()
  @IsOptional()
  ipAddress?: string;

  @IsNumber()
  @IsOptional()
  port?: number;

  @IsString()
  @IsOptional()
  locationName?: string;
}

export class PushBiometricLogDto {
  @IsString()
  @IsNotEmpty()
  deviceSerialNumber: string;

  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  punchTime: string;

  @IsString()
  @IsOptional()
  punchType?: string; // CHECK_IN, CHECK_OUT, BREAK

  @IsString()
  @IsOptional()
  verificationMode?: string; // FINGERPRINT, FACE, CARD, PIN
}
