import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Role } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SettingsService } from './settings.service';
import { UpdateShiftDto } from './dto/update-shift.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('shifts')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async getAllShifts(@CurrentUser() user: { organizationId: string }) {
    return this.settingsService.getAllShifts(user.organizationId);
  }

  @Get('default')
  async getDefaultShift(@CurrentUser() user: { organizationId: string }) {
    return this.settingsService.getDefaultShift(user.organizationId);
  }

  @Post()
  @Roles(Role.HR, Role.ADMIN)
  async createShift(
    @CurrentUser() user: { organizationId: string },
    @Body() dto: UpdateShiftDto & { isDefault?: boolean },
  ) {
    return this.settingsService.createShift(user.organizationId, dto);
  }

  @Patch(':id')
  @Roles(Role.HR, Role.ADMIN)
  async updateShift(
    @CurrentUser() user: { organizationId: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateShiftDto & { isDefault?: boolean },
  ) {
    return this.settingsService.updateShift(user.organizationId, id, dto);
  }

  @Delete(':id')
  @Roles(Role.HR, Role.ADMIN)
  async deleteShift(
    @CurrentUser() user: { organizationId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.settingsService.deleteShift(user.organizationId, id);
  }
}
