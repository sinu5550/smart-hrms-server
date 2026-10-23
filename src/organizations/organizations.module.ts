import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { OrganizationsController } from "./organizations.controller";
import { OrganizationsService } from "./organizations.service";

@Module({ imports: [PassportModule], controllers: [OrganizationsController], providers: [OrganizationsService] })
export class OrganizationsModule {}
