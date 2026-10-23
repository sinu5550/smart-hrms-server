import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AttendanceSessionState,
  AttendanceStatus,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { BreakStartDto, CheckInDto } from "./dto/attendance.dto";

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private getUtcMidnightToday(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }

  private async calculateShiftStatus(
    organizationId: string,
    userId: string,
    checkInDate: Date,
  ): Promise<AttendanceStatus> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { shiftId: true },
    });

    let setting = user?.shiftId
      ? await this.prisma.officeSetting.findUnique({ where: { id: user.shiftId } })
      : null;

    if (!setting) {
      setting = await this.prisma.officeSetting.findFirst({
        where: { organizationId, isDefault: true },
      });
    }

    const startTimeStr = setting?.startTime || "09:00";
    const graceMinutes = setting?.gracePeriodMinutes ?? 30;

    const [startHour, startMinute] = startTimeStr.split(":").map(Number);

    // Convert the cutoff time to minutes, for example 09:00 + 30 minutes = 570 (09:30 AM).
    const cutoffTotalMinutes = startHour * 60 + startMinute + graceMinutes;

    // Convert the employee's current check-in time to minutes.
    const checkInTotalMinutes =
      checkInDate.getHours() * 60 + checkInDate.getMinutes();

    if (checkInTotalMinutes > cutoffTotalMinutes) {
      return AttendanceStatus.LATE;
    }
    return AttendanceStatus.PRESENT;
  }

  async getTodayStatus(organizationId: string, userId: string) {
    const today = this.getUtcMidnightToday();

    const attendance = await this.prisma.attendance.findUnique({
      where: { userId_date: { userId, date: today } },
      include: {
        breaks: {
          orderBy: { startTime: "desc" },
        },
      },
    });

    if (!attendance) {
      return {
        checkedIn: false,
        checkedOut: false,
        attendance: null,
      };
    }

    return {
      checkedIn: true,
      checkedOut:
        attendance.currentState === AttendanceSessionState.CHECKED_OUT,
      attendance,
    };
  }

  async checkIn(organizationId: string, userId: string, dto: CheckInDto, ipAddress: string) {
    const validQrSecret = this.configService.get<string>("OFFICE_QR_SECRET");
    if (dto.qrSecret !== validQrSecret) {
      throw new ForbiddenException(
        "Invalid or expired office QR code signature.",
      );
    }

    const today = this.getUtcMidnightToday();
    const now = new Date();

    const existingRecord = await this.prisma.attendance.findUnique({
      where: { userId_date: { userId, date: today } },
    });

    if (existingRecord) {
      throw new ConflictException(
        "Attendance check-in already recorded for today.",
      );
    }

    const status = await this.calculateShiftStatus(organizationId, userId, now);

    return this.prisma.attendance.create({
      data: {
        organizationId,
        userId,
        date: today,
        checkInTime: now,
        currentState: AttendanceSessionState.CHECKED_IN,
        status,
        ipAddress,
        punchInLatitude: dto.latitude || null,
        punchInLongitude: dto.longitude || null,
        punchInAddress: dto.address || null,
        punchInDeviceType: dto.deviceType || "MOBILE_PWA",
        punchInSelfieUrl: dto.selfieUrl || null,
      },
      include: {
        breaks: true,
      },
    });
  }

  async startBreak(organizationId: string, userId: string, dto: BreakStartDto, ipAddress: string) {
    const today = this.getUtcMidnightToday();

    return this.prisma.$transaction(async (tx) => {
      const attendance = await tx.attendance.findUnique({
        where: { userId_date: { userId, date: today } },
        include: { breaks: { where: { endTime: null } } },
      });

      if (!attendance) {
        throw new NotFoundException(
          "Cannot initiate a break without an active check-in today.",
        );
      }

      if (attendance.currentState === AttendanceSessionState.CHECKED_OUT) {
        throw new BadRequestException(
          "Cannot start a break after checking out.",
        );
      }

      if (
        attendance.currentState === AttendanceSessionState.ON_BREAK ||
        attendance.breaks.length > 0
      ) {
        throw new ConflictException(
          "An active break session is already in progress.",
        );
      }

      const [newBreak] = await Promise.all([
        tx.attendanceBreak.create({
          data: {
            attendanceId: attendance.id,
            breakType: dto.breakType,
            startTime: new Date(),
            ipAddress,
          },
        }),
        tx.attendance.update({
          where: { id: attendance.id },
          data: { currentState: AttendanceSessionState.ON_BREAK },
        }),
      ]);

      return newBreak;
    });
  }

  async endBreak(organizationId: string, userId: string) {
    const today = this.getUtcMidnightToday();

    return this.prisma.$transaction(async (tx) => {
      const attendance = await tx.attendance.findUnique({
        where: { userId_date: { userId, date: today } },
        include: { breaks: { where: { endTime: null } } },
      });

      if (!attendance) {
        throw new NotFoundException("Attendance check-in record not found.");
      }

      if (
        attendance.currentState !== AttendanceSessionState.ON_BREAK ||
        attendance.breaks.length === 0
      ) {
        throw new BadRequestException("No active open break found to end.");
      }

      const activeBreak = attendance.breaks[0];
      const now = new Date();
      const durationMinutes = Math.max(
        1,
        Math.round(
          (now.getTime() - activeBreak.startTime.getTime()) / (1000 * 60),
        ),
      );

      await tx.attendanceBreak.update({
        where: { id: activeBreak.id },
        data: {
          endTime: now,
          durationMinutes,
        },
      });

      return tx.attendance.update({
        where: { id: attendance.id },
        data: {
          currentState: AttendanceSessionState.CHECKED_IN,
          totalBreakMinutes: { increment: durationMinutes },
        },
        include: {
          breaks: { orderBy: { startTime: "desc" } },
        },
      });
    });
  }

  async checkOut(organizationId: string, userId: string, dto?: { latitude?: number; longitude?: number; address?: string }) {
    const today = this.getUtcMidnightToday();

    return this.prisma.$transaction(async (tx) => {
      const attendance = await tx.attendance.findUnique({
        where: { userId_date: { userId, date: today } },
      });

      if (!attendance) {
        throw new NotFoundException(
          "Cannot check out without a check-in record for today.",
        );
      }

      if (attendance.currentState === AttendanceSessionState.ON_BREAK) {
        throw new BadRequestException(
          "You are currently on break. End break before check-out.",
        );
      }

      if (attendance.currentState === AttendanceSessionState.CHECKED_OUT) {
        throw new ConflictException(
          "You have already checked out for today.",
        );
      }

      const now = new Date();
      const elapsedTotalMinutes = Math.max(
        0,
        Math.round(
          (now.getTime() - attendance.checkInTime.getTime()) / (1000 * 60),
        ),
      );
      const totalWorkMinutes = Math.max(
        0,
        elapsedTotalMinutes - attendance.totalBreakMinutes,
      );

      return tx.attendance.update({
        where: { id: attendance.id },
        data: {
          checkOutTime: now,
          currentState: AttendanceSessionState.CHECKED_OUT,
          totalWorkMinutes,
          punchOutLatitude: dto?.latitude || null,
          punchOutLongitude: dto?.longitude || null,
          punchOutAddress: dto?.address || null,
        },
        include: {
          breaks: { orderBy: { startTime: "desc" } },
        },
      });
    });
  }

  // HR Admin: Get all attendance records for today
  async getAdminTodayAttendance(organizationId: string) {
    const today = this.getUtcMidnightToday();

    return this.prisma.attendance.findMany({
      where: { organizationId, date: today },
      include: {
        user: {
          select: {
            id: true,
            employeeId: true,
            fullName: true,
            avatarUrl: true,
            department: { select: { name: true } },
          },
        },
        breaks: {
          orderBy: { startTime: "desc" },
        },
      },
      orderBy: { checkInTime: "asc" },
    });
  }

  // HR Admin: Get attendance records for a date range
  async getAdminAttendanceByDate(organizationId: string, date: string) {
    const targetDate = new Date(date);

    return this.prisma.attendance.findMany({
      where: { organizationId, date: targetDate },
      include: {
        user: {
          select: {
            id: true,
            employeeId: true,
            fullName: true,
            avatarUrl: true,
            department: { select: { name: true } },
          },
        },
        breaks: {
          orderBy: { startTime: "desc" },
        },
      },
      orderBy: { checkInTime: "asc" },
    });
  }
}
