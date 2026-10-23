import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Role } from "@prisma/client";
import { OfficeIpGuard } from "../common/guards/office-ip.guard";
import { ClientIp } from "../common/decorators/client-ip.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { AttendanceService } from "./attendance.service";
import { BreakStartDto, CheckInDto, CheckOutDto } from "./dto/attendance.dto";

interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  organizationId: string;
}

@Controller("attendance")
@UseGuards(AuthGuard("jwt"))
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  // Employee: Get today's attendance status (no IP guard needed — just reading data)
  @Get("today-status")
  async getTodayStatus(@CurrentUser() user: JwtPayload) {
    return this.attendanceService.getTodayStatus(user.organizationId, user.userId);
  }

  // Employee: Check in (requires office IP)
  @Post("check-in")
  @UseGuards(OfficeIpGuard)
  @HttpCode(HttpStatus.OK)
  async checkIn(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CheckInDto,
    @ClientIp() ipAddress: string,
  ) {
    return this.attendanceService.checkIn(user.organizationId, user.userId, dto, ipAddress);
  }

  // Employee: Start break (requires office IP)
  @Post("break-start")
  @UseGuards(OfficeIpGuard)
  @HttpCode(HttpStatus.OK)
  async startBreak(
    @CurrentUser() user: JwtPayload,
    @Body() dto: BreakStartDto,
    @ClientIp() ipAddress: string,
  ) {
    return this.attendanceService.startBreak(user.organizationId, user.userId, dto, ipAddress);
  }

  // Employee: End break (requires office IP)
  @Post("break-end")
  @UseGuards(OfficeIpGuard)
  @HttpCode(HttpStatus.OK)
  async endBreak(@CurrentUser() user: JwtPayload) {
    return this.attendanceService.endBreak(user.organizationId, user.userId);
  }

  // Employee: Check out (requires office IP)
  @Post("check-out")
  @UseGuards(OfficeIpGuard)
  @HttpCode(HttpStatus.OK)
  async checkOut(
    @CurrentUser() user: JwtPayload,
    @Body() dto?: CheckOutDto,
  ) {
    return this.attendanceService.checkOut(user.organizationId, user.userId, dto);
  }

  // HR/Admin: Get all today's attendance records
  @Get("admin/today")
  @UseGuards(RolesGuard)
  @Roles(Role.HR, Role.ADMIN)
  async getAdminToday(@CurrentUser() user: JwtPayload) {
    return this.attendanceService.getAdminTodayAttendance(user.organizationId);
  }

  // HR/Admin: Get attendance records for a specific date
  @Get("admin/by-date")
  @UseGuards(RolesGuard)
  @Roles(Role.HR, Role.ADMIN)
  async getAdminByDate(@CurrentUser() user: JwtPayload, @Query("date") date: string) {
    return this.attendanceService.getAdminAttendanceByDate(user.organizationId, date);
  }
}
