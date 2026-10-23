import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async getAllRoles(organizationId: string) {
    return this.prisma.customRole.findMany({
      where: { organizationId },
      include: {
        _count: {
          select: { users: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getRoleById(organizationId: string, id: string) {
    const role = await this.prisma.customRole.findFirst({
      where: { id, organizationId },
      include: {
        _count: {
          select: { users: true },
        },
      },
    });
    if (!role) {
      throw new NotFoundException('Role not found.');
    }
    return role;
  }

  async createRole(organizationId: string, dto: CreateRoleDto) {
    const existing = await this.prisma.customRole.findFirst({
      where: {
        organizationId,
        name: { equals: dto.name, mode: 'insensitive' },
      },
    });

    if (existing) {
      throw new BadRequestException(`Role "${dto.name}" already exists in this workspace.`);
    }

    return this.prisma.customRole.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description || null,
        permissions: dto.permissions || [],
        isSystem: false,
      },
      include: {
        _count: { select: { users: true } },
      },
    });
  }

  async updateRole(organizationId: string, id: string, dto: UpdateRoleDto) {
    const role = await this.getRoleById(organizationId, id);

    if (dto.name && dto.name !== role.name) {
      const existing = await this.prisma.customRole.findFirst({
        where: {
          organizationId,
          name: { equals: dto.name, mode: 'insensitive' },
          id: { not: id },
        },
      });
      if (existing) {
        throw new BadRequestException(`Another role named "${dto.name}" already exists.`);
      }
    }

    const updatedRole = await this.prisma.customRole.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.permissions !== undefined ? { permissions: dto.permissions } : {}),
      },
      include: {
        _count: { select: { users: true } },
      },
    });

    // If permissions changed, sync to all users assigned to this custom role!
    if (dto.permissions !== undefined) {
      await this.prisma.user.updateMany({
        where: { customRoleId: id, organizationId },
        data: {
          permissions: dto.permissions,
        },
      });
    }

    return updatedRole;
  }

  async deleteRole(organizationId: string, id: string) {
    const role = await this.getRoleById(organizationId, id);
    if (role.isSystem) {
      throw new BadRequestException('System roles cannot be deleted.');
    }

    const assignedUsers = await this.prisma.user.count({
      where: { customRoleId: id },
    });

    if (assignedUsers > 0) {
      throw new BadRequestException(
        `Cannot delete role "${role.name}" because ${assignedUsers} employee(s) are currently assigned to it.`
      );
    }

    return this.prisma.customRole.delete({
      where: { id },
    });
  }
}
