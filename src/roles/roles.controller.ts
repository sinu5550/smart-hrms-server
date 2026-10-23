import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesService } from './roles.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@Controller('roles')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN, Role.HR)
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  async getAllRoles(@CurrentUser() user: { organizationId: string }) {
    return this.rolesService.getAllRoles(user.organizationId);
  }

  @Get(':id')
  async getRoleById(
    @CurrentUser() user: { organizationId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rolesService.getRoleById(user.organizationId, id);
  }

  @Post()
  async createRole(
    @CurrentUser() user: { organizationId: string },
    @Body() dto: CreateRoleDto,
  ) {
    return this.rolesService.createRole(user.organizationId, dto);
  }

  @Patch(':id')
  async updateRole(
    @CurrentUser() user: { organizationId: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.rolesService.updateRole(user.organizationId, id, dto);
  }

  @Delete(':id')
  async deleteRole(
    @CurrentUser() user: { organizationId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rolesService.deleteRole(user.organizationId, id);
  }
}
