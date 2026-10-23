import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CoreHrService } from './core-hr.service';
import {
  CreateBranchDto,
  CreateHolidayDto,
  CreateJobGradeDto,
  CreateGazetteRuleDto,
} from './dto/core-hr.dto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@Controller('core-hr')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(Role.ADMIN, Role.HR)
export class CoreHrController {
  constructor(private readonly coreHrService: CoreHrService) {}

  // Branches
  @Get('branches')
  async getBranches(@CurrentUser() user: { organizationId: string }) {
    return this.coreHrService.getBranches(user.organizationId);
  }

  @Post('branches')
  async createBranch(
    @CurrentUser() user: { organizationId: string },
    @Body() dto: CreateBranchDto,
  ) {
    return this.coreHrService.createBranch(user.organizationId, dto);
  }

  @Delete('branches/:id')
  async deleteBranch(
    @CurrentUser() user: { organizationId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.coreHrService.deleteBranch(user.organizationId, id);
  }

  // Holidays
  @Get('holidays')
  async getHolidays(@CurrentUser() user: { organizationId: string }) {
    return this.coreHrService.getHolidays(user.organizationId);
  }

  @Post('holidays')
  async createHoliday(
    @CurrentUser() user: { organizationId: string },
    @Body() dto: CreateHolidayDto,
  ) {
    return this.coreHrService.createHoliday(user.organizationId, dto);
  }

  @Delete('holidays/:id')
  async deleteHoliday(
    @CurrentUser() user: { organizationId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.coreHrService.deleteHoliday(user.organizationId, id);
  }

  // Job Grades
  @Get('grades')
  async getJobGrades(@CurrentUser() user: { organizationId: string }) {
    return this.coreHrService.getJobGrades(user.organizationId);
  }

  @Post('grades')
  async createJobGrade(
    @CurrentUser() user: { organizationId: string },
    @Body() dto: CreateJobGradeDto,
  ) {
    return this.coreHrService.createJobGrade(user.organizationId, dto);
  }

  // Gazette Wage Rules
  @Get('gazette')
  async getGazetteRules(@CurrentUser() user: { organizationId: string }) {
    return this.coreHrService.getGazetteRules(user.organizationId);
  }

  @Post('gazette')
  async createGazetteRule(
    @CurrentUser() user: { organizationId: string },
    @Body() dto: CreateGazetteRuleDto,
  ) {
    return this.coreHrService.createGazetteRule(user.organizationId, dto);
  }

  // ID Card Studio Templates
  @Get('id-card-templates')
  async getIdCardTemplates(@CurrentUser() user: { organizationId: string }) {
    return this.coreHrService.getIdCardTemplates(user.organizationId);
  }

  @Post('id-card-templates')
  async saveIdCardTemplate(
    @CurrentUser() user: { organizationId: string },
    @Body() dto: any,
  ) {
    return this.coreHrService.saveIdCardTemplate(user.organizationId, dto);
  }
}
