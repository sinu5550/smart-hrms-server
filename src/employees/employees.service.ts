import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EmploymentStatus, Prisma } from "@prisma/client";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import {
  ChangeEmploymentStatusDto,
  CreateEmployeeDto,
  SoftDeleteEmployeeDto,
  UpdateEmployeeDto,
} from "./dto/employee.dto";

@Injectable()
export class EmployeesService {
  private readonly supabase: SupabaseClient;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.supabase = createClient(
      this.configService.getOrThrow<string>("SUPABASE_URL"),
      this.configService.getOrThrow<string>("SUPABASE_SERVICE_ROLE_KEY"),
    );
  }

  async getAll(query: {
    organizationId: string;
    search?: string;
    status?: string;
    bloodGroup?: string;
    departmentId?: string;
  }) {
    const where: Prisma.UserWhereInput = { organizationId: query.organizationId, isDeleted: false };

    if (query.status && query.status !== "ALL") {
      where.status = query.status as EmploymentStatus;
    }

    if (query.bloodGroup && query.bloodGroup !== "ALL") {
      where.bloodGroup = query.bloodGroup;
    }

    if (query.departmentId && query.departmentId !== "ALL") {
      where.departmentId = query.departmentId;
    }

    if (query.search) {
      where.OR = [
        { fullName: { contains: query.search, mode: "insensitive" } },
        { employeeId: { contains: query.search, mode: "insensitive" } },
        { phone: { contains: query.search } },
        { email: { contains: query.search, mode: "insensitive" } },
      ];
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: query.organizationId },
      select: { ownerEmail: true },
    });
    const ownerEmail = org?.ownerEmail?.toLowerCase();

    const employees = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        employeeId: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        bloodGroup: true,
        avatarUrl: true,
        permissions: true,
        joiningDate: true,
        gender: true,
        dateOfBirth: true,
        presentAddress: true,
        permanentAddress: true,
        emergencyContactName: true,
        emergencyContactPhone: true,
        emergencyContactRelation: true,
        nidOrPassport: true,
        departmentId: true,
        designationId: true,
        shiftId: true,
        customRoleId: true,
        department: { select: { id: true, name: true } },
        designation: { select: { id: true, name: true } },
        shift: { select: { id: true, shiftName: true, startTime: true, endTime: true } },
        customRole: { select: { id: true, name: true, permissions: true } },
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return employees.map((emp) => ({
      ...emp,
      isOwner: Boolean(ownerEmail && emp.email?.toLowerCase() === ownerEmail),
    }));
  }

  async getById(organizationId: string, id: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { ownerEmail: true },
    });
    const ownerEmail = org?.ownerEmail?.toLowerCase();

    const user = await this.prisma.user.findFirst({
      where: { id, organizationId },
      select: {
        id: true,
        employeeId: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        bloodGroup: true,
        avatarUrl: true,
        permissions: true,
        joiningDate: true,
        resignationDate: true,
        gender: true,
        dateOfBirth: true,
        presentAddress: true,
        permanentAddress: true,
        emergencyContactName: true,
        emergencyContactPhone: true,
        emergencyContactRelation: true,
        nidOrPassport: true,
        departmentId: true,
        designationId: true,
        shiftId: true,
        customRoleId: true,
        department: { select: { id: true, name: true } },
        designation: { select: { id: true, name: true } },
        shift: { select: { id: true, shiftName: true, startTime: true, endTime: true } },
        customRole: { select: { id: true, name: true, permissions: true } },
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException("Employee not found.");
    }

    return {
      ...user,
      isOwner: Boolean(ownerEmail && user.email?.toLowerCase() === ownerEmail),
    };
  }

  async create(organizationId: string, dto: CreateEmployeeDto) {
    if (dto.departmentId && !(await this.prisma.department.findFirst({ where: { id: dto.departmentId, organizationId } }))) {
      throw new NotFoundException("Department is not in this organization.");
    }
    if (dto.designationId && !(await this.prisma.designation.findFirst({ where: { id: dto.designationId, organizationId } }))) {
      throw new NotFoundException("Designation is not in this organization.");
    }
    const organization = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { employeePrefix: true } });
    if (!organization) throw new NotFoundException("Organization not found.");
    const employeeId = dto.employeeId.trim().toUpperCase();
    if (!employeeId.startsWith(`${organization.employeePrefix}-`)) {
      throw new BadRequestException(`Employee ID must start with your organization's ${organization.employeePrefix} prefix.`);
    }
    // Check employeeId conflict within organization
    const existingId = await this.prisma.user.findFirst({
      where: { organizationId, employeeId },
    });
    if (existingId) {
      throw new ConflictException(`Employee ID "${employeeId}" is already taken in this organization.`);
    }

    // Check email conflict (globally or within org)
    const existingEmail = await this.prisma.user.findFirst({
      where: { email: dto.email.trim().toLowerCase() },
    });
    if (existingEmail) {
      throw new ConflictException(`Work Email "${dto.email}" is already registered in the system.`);
    }

    // Check phone conflict
    if (dto.phone) {
      const existingPhone = await this.prisma.user.findFirst({
        where: { organizationId, phone: dto.phone },
      });
      if (existingPhone) {
        throw new ConflictException(`Phone number "${dto.phone}" is already assigned to another employee.`);
      }
    }

    const initialPassword = dto.password?.trim() ? dto.password.trim() : crypto.randomBytes(8).toString("hex");
    const passwordHash = await bcrypt.hash(initialPassword, 12);

    const user = await this.prisma.user.create({
      data: {
        organizationId,
        employeeId,
        email: dto.email.toLowerCase(),
        fullName: dto.fullName,
        phone: dto.phone,
        role: dto.role || "EMPLOYEE",
        departmentId: dto.departmentId,
        designationId: dto.designationId,
        shiftId: dto.shiftId,
        customRoleId: dto.customRoleId,
        permissions: dto.customRoleId
          ? (await this.prisma.customRole.findUnique({ where: { id: dto.customRoleId } }))?.permissions || []
          : [],
        passwordHash,
        mustChangePassword: !dto.password?.trim(),
        bloodGroup: dto.bloodGroup,
        presentAddress: dto.presentAddress,
        permanentAddress: dto.permanentAddress,
        emergencyContactName: dto.emergencyContactName,
        emergencyContactPhone: dto.emergencyContactPhone,
        emergencyContactRelation: dto.emergencyContactRelation,
        nidOrPassport: dto.nidOrPassport,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        gender: dto.gender,
        joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : undefined,
      },
      select: {
        id: true,
        employeeId: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
      },
    });

    return {
      user,
      initialTemporaryPassword: initialPassword,
    };
  }

  async update(organizationId: string, id: string, dto: UpdateEmployeeDto) {
    const user = await this.prisma.user.findFirst({ where: { id, organizationId } });
    if (!user || user.isDeleted) {
      throw new NotFoundException("Employee not found or already deleted.");
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { ownerEmail: true },
    });
    const isOwner = Boolean(org?.ownerEmail && org.ownerEmail.toLowerCase() === user.email.toLowerCase());

    if (isOwner && dto.role && dto.role !== user.role) {
      throw new ForbiddenException("Organization owner system role is locked and cannot be demoted.");
    }

    if (dto.departmentId && !(await this.prisma.department.findFirst({ where: { id: dto.departmentId, organizationId } }))) {
      throw new NotFoundException("Department is not in this organization.");
    }
    if (dto.designationId && !(await this.prisma.designation.findFirst({ where: { id: dto.designationId, organizationId } }))) {
      throw new NotFoundException("Designation is not in this organization.");
    }

    // Check email uniqueness if changing
    const normalizedEmail = dto.email?.trim().toLowerCase();
    if (normalizedEmail && normalizedEmail !== user.email) {
      const emailCollision = await this.prisma.user.findFirst({
        where: { email: normalizedEmail },
      });
      if (emailCollision && emailCollision.id !== id) {
        throw new ConflictException("Email is already assigned to another employee.");
      }
    }

    // Check phone uniqueness if changing
    if (dto.phone && dto.phone !== user.phone) {
      const phoneCollision = await this.prisma.user.findFirst({
        where: { organizationId, phone: dto.phone },
      });
      if (phoneCollision && phoneCollision.id !== id) {
        throw new ConflictException("Phone number is already assigned to another employee.");
      }
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        fullName: dto.fullName,
        email: normalizedEmail,
        phone: dto.phone,
        role: dto.role,
        departmentId: dto.departmentId,
        designationId: dto.designationId,
        shiftId: dto.shiftId,
        customRoleId: dto.customRoleId,
        bloodGroup: dto.bloodGroup,
        presentAddress: dto.presentAddress,
        permanentAddress: dto.permanentAddress,
        emergencyContactName: dto.emergencyContactName,
        emergencyContactPhone: dto.emergencyContactPhone,
        emergencyContactRelation: dto.emergencyContactRelation,
        nidOrPassport: dto.nidOrPassport,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        gender: dto.gender,
        joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : undefined,
        avatarUrl: dto.avatarUrl,
        ...(dto.permissions
          ? { permissions: dto.permissions }
          : dto.customRoleId && dto.customRoleId !== user.customRoleId
          ? {
              permissions:
                (await this.prisma.customRole.findUnique({ where: { id: dto.customRoleId } }))?.permissions || [],
            }
          : {}),
      },
      select: {
        id: true,
        employeeId: true,
        fullName: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        bloodGroup: true,
        avatarUrl: true,
        permissions: true,
        shiftId: true,
        shift: { select: { id: true, shiftName: true, startTime: true, endTime: true } },
        updatedAt: true,
      },
    });
  }

  async changeStatus(organizationId: string, id: string, dto: ChangeEmploymentStatusDto) {
    const user = await this.prisma.user.findFirst({ where: { id, organizationId } });
    if (!user || user.isDeleted) {
      throw new NotFoundException("Employee not found or already deleted.");
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { ownerEmail: true },
    });

    if (organization?.ownerEmail && organization.ownerEmail.toLowerCase() === user.email.toLowerCase()) {
      throw new ForbiddenException("Organization owner status cannot be changed or deactivated.");
    }

    const invalidatingStatuses: EmploymentStatus[] = [
      EmploymentStatus.RESIGNED,
      EmploymentStatus.TERMINATED,
      EmploymentStatus.SUSPENDED,
    ];
    const shouldInvalidateTokens = invalidatingStatuses.includes(dto.status);

    return this.prisma.user.update({
      where: { id },
      data: {
        status: dto.status,
        ...(shouldInvalidateTokens ? { refreshTokenHash: null } : {}),
        ...(dto.status === EmploymentStatus.RESIGNED
          ? { resignationDate: new Date() }
          : {}),
      },
      select: { id: true, employeeId: true, status: true, updatedAt: true },
    });
  }

  async softDelete(organizationId: string, id: string, dto: SoftDeleteEmployeeDto) {
    const user = await this.prisma.user.findFirst({ where: { id, organizationId } });
    if (!user || user.isDeleted) {
      throw new NotFoundException(
        "Employee record does not exist or has already been removed.",
      );
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { ownerEmail: true },
    });

    if (org?.ownerEmail && org.ownerEmail.toLowerCase() === user.email.toLowerCase()) {
      throw new ForbiddenException("Organization owner account cannot be deleted.");
    }

    const expectedConfirmation = `DELETE_EMPLOYEE_${user.employeeId}`;
    if (dto.confirmationText !== expectedConfirmation) {
      throw new BadRequestException(
        "Action aborted: Explicit deletion confirmation string mismatched.",
      );
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        status: EmploymentStatus.TERMINATED,
        refreshTokenHash: null,
      },
      select: {
        id: true,
        employeeId: true,
        isDeleted: true,
        deletedAt: true,
      },
    });
  }

  async uploadAvatar(organizationId: string, id: string, file: Express.Multer.File) {
    const user = await this.prisma.user.findFirst({ where: { id, organizationId } });
    if (!user || user.isDeleted) {
      throw new NotFoundException("Employee not found.");
    }

    const cloudName = this.configService.get<string>("CLOUDINARY_CLOUD_NAME") || "jawcusfd";
    const uploadPreset = this.configService.get<string>("CLOUDINARY_UPLOAD_PRESET") || "ekhone-hrms";

    try {
      const base64Data = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
      const formData = new FormData();
      formData.append("file", base64Data);
      formData.append("upload_preset", uploadPreset);
      formData.append("folder", "hrms/employee-avatars");

      const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok || !data.secure_url) {
        throw new Error(data.error?.message || "Failed to upload image to Cloudinary.");
      }

      return this.prisma.user.update({
        where: { id },
        data: { avatarUrl: data.secure_url },
        select: { id: true, employeeId: true, avatarUrl: true },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Image upload failed";
      throw new InternalServerErrorException(`Cloudinary Upload Error: ${message}`);
    }
  }

  async getNextEmployeeId(organizationId: string): Promise<{ nextEmployeeId: string; prefix: string }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { employeePrefix: true },
    });
    const prefix = (org?.employeePrefix || "EKH").trim().toUpperCase();
    const currentYearShort = new Date().getFullYear().toString().slice(-2); // e.g. "26"
    const prefixPattern = `${prefix}-${currentYearShort}-`;

    const employees = await this.prisma.user.findMany({
      where: {
        organizationId,
        employeeId: {
          startsWith: prefixPattern,
        },
      },
      select: { employeeId: true },
    });

    let maxSerial = 0;
    for (const emp of employees) {
      // emp.employeeId is expected to be e.g. "EKH-26-0001"
      const parts = emp.employeeId.split("-");
      if (parts.length === 3) {
        const serialNum = parseInt(parts[2], 10);
        if (!isNaN(serialNum) && serialNum > maxSerial) {
          maxSerial = serialNum;
        }
      }
    }

    const nextSerial = (maxSerial + 1).toString().padStart(4, "0");
    const nextEmployeeId = `${prefix}-${currentYearShort}-${nextSerial}`;

    return { nextEmployeeId, prefix };
  }
}
