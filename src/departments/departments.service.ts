import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateDepartmentDto, UpdateDepartmentDto } from "./dto/department.dto";

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAll(organizationId: string) {
    return this.prisma.department.findMany({
      where: { organizationId },
      include: {
        _count: {
          select: { users: { where: { isDeleted: false } } },
        },
      },
      orderBy: { name: "asc" },
    });
  }

  async getById(organizationId: string, id: string) {
    const dept = await this.prisma.department.findFirst({
      where: { id, organizationId },
      include: {
        _count: { select: { users: { where: { isDeleted: false } } } },
      },
    });
    if (!dept) throw new NotFoundException("Department not found.");
    return dept;
  }

  async create(organizationId: string, dto: CreateDepartmentDto) {
    const name = dto.name.trim();
    const code = (dto.code || name.slice(0, 3)).trim().toUpperCase();

    const existingName = await this.prisma.department.findFirst({
      where: { organizationId, name: { equals: name, mode: "insensitive" } },
    });
    if (existingName) {
      throw new ConflictException(`Department "${name}" already exists.`);
    }

    const existingCode = await this.prisma.department.findFirst({
      where: { organizationId, code },
    });
    if (existingCode) {
      throw new ConflictException(`Department code "${code}" already exists.`);
    }

    return this.prisma.department.create({
      data: {
        name,
        code,
        organizationId,
      },
      include: {
        _count: { select: { users: true } },
      },
    });
  }

  async update(organizationId: string, id: string, dto: UpdateDepartmentDto) {
    const dept = await this.getById(organizationId, id);

    const data: { name?: string; code?: string } = {};
    if (dto.name) {
      const name = dto.name.trim();
      const existing = await this.prisma.department.findFirst({
        where: { organizationId, name: { equals: name, mode: "insensitive" }, NOT: { id } },
      });
      if (existing) throw new ConflictException(`Department "${name}" already exists.`);
      data.name = name;
    }

    if (dto.code) {
      const code = dto.code.trim().toUpperCase();
      const existing = await this.prisma.department.findFirst({
        where: { organizationId, code, NOT: { id } },
      });
      if (existing) throw new ConflictException(`Department code "${code}" already exists.`);
      data.code = code;
    }

    return this.prisma.department.update({
      where: { id },
      data,
      include: {
        _count: { select: { users: true } },
      },
    });
  }

  async delete(organizationId: string, id: string) {
    await this.getById(organizationId, id);
    // Unassign users from this department
    await this.prisma.user.updateMany({
      where: { departmentId: id, organizationId },
      data: { departmentId: null },
    });
    return this.prisma.department.delete({ where: { id } });
  }
}
