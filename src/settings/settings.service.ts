import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UpdateShiftDto } from "./dto/update-shift.dto";

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAllShifts(organizationId: string) {
    return this.prisma.officeSetting.findMany({
      where: { organizationId },
      include: {
        _count: {
          select: { users: true },
        },
      },
      orderBy: { updatedAt: "asc" },
    });
  }

  async getDefaultShift(organizationId: string) {
    const shift = await this.prisma.officeSetting.findFirst({ where: { organizationId, isDefault: true } });
    if (!shift) {
      return this.prisma.officeSetting.findFirst({ where: { organizationId } });
    }
    return shift;
  }

  async createShift(organizationId: string, dto: UpdateShiftDto & { isDefault?: boolean }) {
    if (dto.isDefault) {
      await this.prisma.officeSetting.updateMany({
        where: { organizationId },
        data: { isDefault: false },
      });
    }
    const count = await this.prisma.officeSetting.count({ where: { organizationId } });
    return this.prisma.officeSetting.create({
      data: {
        ...dto,
        organizationId,
        isDefault: dto.isDefault ?? count === 0,
      },
    });
  }

  async updateShift(organizationId: string, id: string, dto: UpdateShiftDto & { isDefault?: boolean }) {
    if (dto.isDefault) {
      await this.prisma.officeSetting.updateMany({
        where: { organizationId },
        data: { isDefault: false },
      });
    }
    return this.prisma.officeSetting.update({
      where: { id },
      data: dto,
    });
  }

  async deleteShift(organizationId: string, id: string) {
    const shift = await this.prisma.officeSetting.findFirst({ where: { id, organizationId } });
    if (!shift) return;
    return this.prisma.officeSetting.delete({ where: { id } });
  }
}
