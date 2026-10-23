import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class UpdateShiftDto {
  @IsOptional()
  @IsString()
  shiftName?: string;

  @IsNotEmpty()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'startTime must be in HH:mm 24-hour format (e.g., 09:00, 10:30)',
  })
  startTime: string;

  @IsNotEmpty()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'endTime must be in HH:mm 24-hour format (e.g., 18:00, 19:00)',
  })
  endTime: string;

  @IsNotEmpty()
  @IsInt()
  @Min(0)
  @Max(120)
  gracePeriodMinutes: number; // For example: 15, 30, or 45 minutes.
}
