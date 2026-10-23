import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateBranchDto,
  CreateHolidayDto,
  CreateJobGradeDto,
  CreateGazetteRuleDto,
} from './dto/core-hr.dto';

@Injectable()
export class CoreHrService {
  constructor(private readonly prisma: PrismaService) {}

  // 1. Branches Management
  async getBranches(organizationId: string) {
    return this.prisma.branch.findMany({
      where: { organizationId },
      include: { _count: { select: { users: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createBranch(organizationId: string, dto: CreateBranchDto) {
    const existing = await this.prisma.branch.findFirst({
      where: { organizationId, code: dto.code.toUpperCase() },
    });
    if (existing) {
      throw new BadRequestException(`Branch code "${dto.code}" is already in use.`);
    }

    return this.prisma.branch.create({
      data: {
        organizationId,
        name: dto.name,
        code: dto.code.toUpperCase(),
        address: dto.address || null,
        city: dto.city || null,
        phone: dto.phone || null,
        email: dto.email || null,
        isHeadOffice: dto.isHeadOffice || false,
      },
    });
  }

  async deleteBranch(organizationId: string, id: string) {
    const branch = await this.prisma.branch.findFirst({ where: { id, organizationId } });
    if (!branch) throw new NotFoundException('Branch not found.');
    return this.prisma.branch.delete({ where: { id } });
  }

  // 2. Holidays Management
  async getHolidays(organizationId: string) {
    return this.prisma.holiday.findMany({
      where: { organizationId },
      orderBy: { fromDate: 'asc' },
    });
  }

  async createHoliday(organizationId: string, dto: CreateHolidayDto) {
    const from = new Date(dto.fromDate);
    const to = new Date(dto.toDate);
    const totalDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)) + 1);

    return this.prisma.holiday.create({
      data: {
        organizationId,
        title: dto.title,
        fromDate: from,
        toDate: to,
        totalDays,
        holidayType: dto.holidayType || 'PUBLIC',
        description: dto.description || null,
      },
    });
  }

  async deleteHoliday(organizationId: string, id: string) {
    return this.prisma.holiday.delete({ where: { id } });
  }

  // 3. Job Grades Management
  async getJobGrades(organizationId: string) {
    return this.prisma.jobGrade.findMany({
      where: { organizationId },
      include: { _count: { select: { users: true } } },
      orderBy: { gradeLevel: 'asc' },
    });
  }

  async createJobGrade(organizationId: string, dto: CreateJobGradeDto) {
    return this.prisma.jobGrade.create({
      data: {
        organizationId,
        gradeName: dto.gradeName,
        gradeLevel: Number(dto.gradeLevel) || 1,
        minBasic: dto.minBasic || 0,
        maxBasic: dto.maxBasic || 0,
        description: dto.description || null,
      },
    });
  }

  async deleteJobGrade(organizationId: string, id: string) {
    return this.prisma.jobGrade.delete({ where: { id } });
  }

  // 4. Gazette Wage Rules Management
  async getGazetteRules(organizationId: string) {
    return this.prisma.gazetteRule.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createGazetteRule(organizationId: string, dto: CreateGazetteRuleDto) {
    if (dto.isDefault) {
      await this.prisma.gazetteRule.updateMany({
        where: { organizationId },
        data: { isDefault: false },
      });
    }

    return this.prisma.gazetteRule.create({
      data: {
        organizationId,
        gazetteName: dto.gazetteName,
        basicPercentage: dto.basicPercentage ?? 50.0,
        houseRentPercentage: dto.houseRentPercentage ?? 25.0,
        medicalAllowanceFixed: dto.medicalAllowanceFixed ?? 4500.0,
        conveyanceAllowanceFixed: dto.conveyanceAllowanceFixed ?? 3500.0,
        foodAllowanceFixed: dto.foodAllowanceFixed ?? 2500.0,
        overtimeMultiplier: dto.overtimeMultiplier ?? 2.0,
        isDefault: dto.isDefault ?? false,
      },
    });
  }

  // 5. ID Card Template Studio
  async getIdCardTemplates(organizationId: string) {
    return this.prisma.idCardTemplate.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async saveIdCardTemplate(organizationId: string, dto: any) {
    return this.prisma.idCardTemplate.create({
      data: {
        organizationId,
        templateName: dto.templateName || 'Default Corporate ID',
        primaryColor: dto.primaryColor || '#047857',
        accentColor: dto.accentColor || '#0f172a',
        showBloodGroup: dto.showBloodGroup ?? true,
        showEmergencyContact: dto.showEmergencyContact ?? true,
        showQrCode: dto.showQrCode ?? true,
        showBarcode: dto.showBarcode ?? false,
        customFooterText: dto.customFooterText || 'If found, return to office administration.',
        isDefault: true,
      },
    });
  }
}
