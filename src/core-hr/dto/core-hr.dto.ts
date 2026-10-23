import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class CreateBranchDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsString()
  @IsOptional()
  city?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsBoolean()
  @IsOptional()
  isHeadOffice?: boolean;
}

export class CreateHolidayDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  fromDate: string;

  @IsString()
  @IsNotEmpty()
  toDate: string;

  @IsString()
  @IsOptional()
  holidayType?: string; // PUBLIC, RELIGIOUS, COMPANY

  @IsString()
  @IsOptional()
  description?: string;
}

export class CreateJobGradeDto {
  @IsString()
  @IsNotEmpty()
  gradeName: string;

  @IsNotEmpty()
  gradeLevel: number;

  @IsOptional()
  minBasic?: number;

  @IsOptional()
  maxBasic?: number;

  @IsString()
  @IsOptional()
  description?: string;
}

export class CreateGazetteRuleDto {
  @IsString()
  @IsNotEmpty()
  gazetteName: string;

  @IsOptional()
  basicPercentage?: number;

  @IsOptional()
  houseRentPercentage?: number;

  @IsOptional()
  medicalAllowanceFixed?: number;

  @IsOptional()
  conveyanceAllowanceFixed?: number;

  @IsOptional()
  foodAllowanceFixed?: number;

  @IsOptional()
  overtimeMultiplier?: number;

  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}
