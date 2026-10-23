import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { AttendanceModule } from "./attendance/attendance.module";
import { EmployeesModule } from "./employees/employees.module";
import { SettingsModule } from "./settings/settings.module";
import { OrganizationsModule } from "./organizations/organizations.module";
import { DepartmentsModule } from "./departments/departments.module";
import { RolesModule } from "./roles/roles.module";
import { DevicesModule } from "./devices/devices.module";
import { CoreHrModule } from "./core-hr/core-hr.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    AttendanceModule,
    EmployeesModule,
    SettingsModule,
    OrganizationsModule,
    DepartmentsModule,
    RolesModule,
    DevicesModule,
    CoreHrModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
