import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Role } from "@prisma/client";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { DepartmentsService } from "./departments.service";
import { CreateDepartmentDto, UpdateDepartmentDto } from "./dto/department.dto";

@Controller("departments")
@UseGuards(AuthGuard("jwt"), RolesGuard)
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Get()
  async getAll(@CurrentUser() user: { organizationId: string }) {
    return this.departmentsService.getAll(user.organizationId);
  }

  @Get(":id")
  async getById(
    @CurrentUser() user: { organizationId: string },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.departmentsService.getById(user.organizationId, id);
  }

  @Post()
  @Roles(Role.HR, Role.ADMIN)
  async create(
    @CurrentUser() user: { organizationId: string },
    @Body() dto: CreateDepartmentDto,
  ) {
    return this.departmentsService.create(user.organizationId, dto);
  }

  @Patch(":id")
  @Roles(Role.HR, Role.ADMIN)
  async update(
    @CurrentUser() user: { organizationId: string },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.departmentsService.update(user.organizationId, id, dto);
  }

  @Delete(":id")
  @Roles(Role.HR, Role.ADMIN)
  async delete(
    @CurrentUser() user: { organizationId: string },
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.departmentsService.delete(user.organizationId, id);
  }
}
