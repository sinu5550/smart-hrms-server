import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { FileInterceptor } from "@nestjs/platform-express";
import { Role } from "@prisma/client";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import {
  ChangeEmploymentStatusDto,
  CreateEmployeeDto,
  SoftDeleteEmployeeDto,
  UpdateEmployeeDto,
} from "./dto/employee.dto";
import { EmployeesService } from "./employees.service";

@Controller("employees")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles(Role.HR, Role.ADMIN)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  async getAll(
    @CurrentUser() user: { organizationId: string },
    @Query("search") search?: string,
    @Query("status") status?: string,
    @Query("bloodGroup") bloodGroup?: string,
    @Query("departmentId") departmentId?: string,
  ) {
    return this.employeesService.getAll({
      organizationId: user.organizationId,
      search,
      status,
      bloodGroup,
      departmentId,
    });
  }

  @Get("next-id")
  async getNextId(@CurrentUser() user: { organizationId: string }) {
    return this.employeesService.getNextEmployeeId(user.organizationId);
  }

  @Get(":id")
  async getById(@CurrentUser() user: { organizationId: string }, @Param("id", ParseUUIDPipe) id: string) {
    return this.employeesService.getById(user.organizationId, id);
  }

  @Post()
  async create(@CurrentUser() user: { organizationId: string }, @Body() dto: CreateEmployeeDto) {
    return this.employeesService.create(user.organizationId, dto);
  }

  @Patch(":id")
  async update(
    @CurrentUser() user: { organizationId: string },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employeesService.update(user.organizationId, id, dto);
  }

  @Patch(":id/status")
  async changeStatus(
    @CurrentUser() user: { organizationId: string },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ChangeEmploymentStatusDto,
  ) {
    return this.employeesService.changeStatus(user.organizationId, id, dto);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  async softDelete(
    @CurrentUser() user: { organizationId: string },
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SoftDeleteEmployeeDto,
  ) {
    return this.employeesService.softDelete(user.organizationId, id, dto);
  }

  @Post(":id/avatar")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 3 * 1024 * 1024 },
      fileFilter: (_req, file, callback) => {
        if (!file.mimetype.match(/^image\/(png|jpeg|jpg|webp)$/)) {
          return callback(
            new BadRequestException(
              "Only PNG, JPEG, and WEBP image formats are supported.",
            ),
            false,
          );
        }
        callback(null, true);
      },
    }),
  )
  async uploadAvatar(
    @CurrentUser() user: { organizationId: string },
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException("Avatar image file must be provided.");
    }
    return this.employeesService.uploadAvatar(user.organizationId, id, file);
  }
}
