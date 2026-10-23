import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { DevicesService } from './devices.service';
import { RegisterBiometricDeviceDto, PushBiometricLogDto } from './dto/device.dto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  // Admin/HR: Get all registered biometric devices
  @Get()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN, Role.HR)
  async getAllDevices(@CurrentUser() user: { organizationId: string }) {
    return this.devicesService.getAllDevices(user.organizationId);
  }

  // Admin/HR: Register new biometric IoT device
  @Post()
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN)
  async registerDevice(
    @CurrentUser() user: { organizationId: string },
    @Body() dto: RegisterBiometricDeviceDto,
  ) {
    return this.devicesService.registerDevice(user.organizationId, dto);
  }

  // Admin: Delete a biometric device
  @Delete(':id')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN)
  async deleteDevice(
    @CurrentUser() user: { organizationId: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.devicesService.deleteDevice(user.organizationId, id);
  }

  // Admin/HR: View recent biometric raw punch logs
  @Get('logs')
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(Role.ADMIN, Role.HR)
  async getRecentLogs(@CurrentUser() user: { organizationId: string }) {
    return this.devicesService.getRecentLogs(user.organizationId);
  }

  // Public/Device Webhook: Biometric Terminal Real-time Push Endpoint (ADMS / REST)
  @Post('webhook/push-log')
  @HttpCode(HttpStatus.OK)
  async pushBiometricLog(@Body() dto: PushBiometricLogDto) {
    return this.devicesService.ingestBiometricLog(dto);
  }
}
