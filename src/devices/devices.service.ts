import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterBiometricDeviceDto, PushBiometricLogDto } from './dto/device.dto';
import { AttendanceSessionState, AttendanceStatus } from '@prisma/client';

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async getAllDevices(organizationId: string) {
    return this.prisma.biometricDevice.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async registerDevice(organizationId: string, dto: RegisterBiometricDeviceDto) {
    const existing = await this.prisma.biometricDevice.findFirst({
      where: { organizationId, deviceSerialNumber: dto.deviceSerialNumber },
    });

    if (existing) {
      throw new BadRequestException(
        `Device with serial number "${dto.deviceSerialNumber}" is already registered.`,
      );
    }

    return this.prisma.biometricDevice.create({
      data: {
        organizationId,
        deviceName: dto.deviceName,
        deviceSerialNumber: dto.deviceSerialNumber,
        deviceModel: dto.deviceModel || 'ZKTeco / ADMS Standalone',
        ipAddress: dto.ipAddress || null,
        port: dto.port || 4370,
        locationName: dto.locationName || 'Main Entrance Gate',
        status: 'ONLINE',
        lastHeartbeat: new Date(),
      },
    });
  }

  async deleteDevice(organizationId: string, id: string) {
    const device = await this.prisma.biometricDevice.findFirst({
      where: { id, organizationId },
    });
    if (!device) throw new NotFoundException('Device not found.');

    return this.prisma.biometricDevice.delete({
      where: { id },
    });
  }

  async ingestBiometricLog(dto: PushBiometricLogDto) {
    // 1. Locate device
    const device = await this.prisma.biometricDevice.findFirst({
      where: { deviceSerialNumber: dto.deviceSerialNumber },
    });

    if (!device || !device.organizationId) {
      throw new NotFoundException(
        `Unregistered hardware device serial: ${dto.deviceSerialNumber}`,
      );
    }

    // 2. Find user in the same organization
    const user = await this.prisma.user.findFirst({
      where: {
        organizationId: device.organizationId,
        employeeId: dto.employeeId,
      },
    });

    if (!user) {
      throw new NotFoundException(
        `Employee ID "${dto.employeeId}" not found in workspace.`,
      );
    }

    const punchDate = new Date(dto.punchTime);
    const utcMidnightToday = new Date(
      Date.UTC(punchDate.getUTCFullYear(), punchDate.getUTCMonth(), punchDate.getUTCDate()),
    );

    // 3. Record raw punch
    await this.prisma.biometricRawLog.create({
      data: {
        organizationId: device.organizationId,
        deviceId: device.id,
        deviceSerialNumber: dto.deviceSerialNumber,
        employeeId: dto.employeeId,
        punchTime: punchDate,
        punchType: dto.punchType || 'CHECK_IN',
        verificationMode: dto.verificationMode || 'FINGERPRINT',
        syncStatus: 'PROCESSED',
      },
    });

    // 4. Update device heartbeat & sync counter
    await this.prisma.biometricDevice.update({
      where: { id: device.id },
      data: {
        lastHeartbeat: new Date(),
        totalLogsSynced: { increment: 1 },
        status: 'ONLINE',
      },
    });

    // 5. Auto sync to Attendance ledger
    const existingAttendance = await this.prisma.attendance.findUnique({
      where: {
        userId_date: {
          userId: user.id,
          date: utcMidnightToday,
        },
      },
    });

    if (!existingAttendance) {
      // First punch of the day: create check-in
      await this.prisma.attendance.create({
        data: {
          organizationId: device.organizationId,
          userId: user.id,
          date: utcMidnightToday,
          checkInTime: punchDate,
          currentState: AttendanceSessionState.CHECKED_IN,
          status: AttendanceStatus.PRESENT,
          ipAddress: device.ipAddress || 'BIOMETRIC_HARDWARE',
          punchInDeviceType: 'BIOMETRIC_TERMINAL',
          punchInAddress: device.locationName,
        },
      });
    } else if (existingAttendance.currentState !== AttendanceSessionState.CHECKED_OUT) {
      // Subsequent punch of the day: update check-out time & work duration
      const elapsedMinutes = Math.max(
        0,
        Math.round((punchDate.getTime() - existingAttendance.checkInTime.getTime()) / (1000 * 60)),
      );
      const totalWorkMinutes = Math.max(
        0,
        elapsedMinutes - existingAttendance.totalBreakMinutes,
      );

      await this.prisma.attendance.update({
        where: { id: existingAttendance.id },
        data: {
          checkOutTime: punchDate,
          currentState: AttendanceSessionState.CHECKED_OUT,
          totalWorkMinutes,
          punchOutAddress: device.locationName,
        },
      });
    }

    return { success: true, message: 'Punch log processed successfully' };
  }

  async getRecentLogs(organizationId: string) {
    return this.prisma.biometricRawLog.findMany({
      where: { organizationId },
      orderBy: { punchTime: 'desc' },
      take: 50,
      include: {
        device: { select: { deviceName: true, locationName: true } },
      },
    });
  }
}
