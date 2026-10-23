import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { OrganizationStatus, Role, SubscriptionPlan, SubscriptionStatus } from "@prisma/client";
import { IsEnum, IsOptional } from "class-validator";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { SelfServiceRegistrationDto } from "./dto/register-organization.dto";
import { OrganizationsService } from "./organizations.service";

class UpdateOrganizationDto {
  @IsOptional() @IsEnum(OrganizationStatus) status?: OrganizationStatus;
  @IsOptional() @IsEnum(SubscriptionPlan) plan?: SubscriptionPlan;
  @IsOptional() @IsEnum(SubscriptionStatus) subscriptionStatus?: SubscriptionStatus;
}

@Controller("organizations")
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService, private readonly prisma: PrismaService) {}

  @Post("register") register(@Body() dto: SelfServiceRegistrationDto) { return this.organizations.register(dto); }
  @Get("verify") verify(@Query("token") token: string) { return this.organizations.verify(token); }

  @Get("platform")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  async listForPlatform() {
    const [organizations, total, active, pending] = await this.prisma.$transaction([
      this.prisma.organization.findMany({ select: { id: true, name: true, slug: true, emailDomain: true, ownerEmail: true, logoUrl: true, status: true, domainVerifiedAt: true, createdAt: true, subscriptions: { orderBy: { createdAt: "desc" }, take: 1, select: { plan: true, status: true, trialEndsAt: true, currentPeriodEnd: true } }, _count: { select: { users: true } } }, orderBy: { createdAt: "desc" } }),
      this.prisma.organization.count(),
      this.prisma.organization.count({ where: { status: { in: [OrganizationStatus.TRIAL, OrganizationStatus.ACTIVE] } } }),
      this.prisma.organization.count({ where: { status: OrganizationStatus.PENDING_VERIFICATION } }),
    ]);
    return { summary: { total, active, pending }, organizations };
  }

  @Get("current")
  @UseGuards(AuthGuard("jwt"))
  async getCurrentOrganization(@CurrentUser() user: { organizationId: string | null; role: Role }) {
    if (!user.organizationId) {
      return { organization: null };
    }
    const organization = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        emailDomain: true,
        employeePrefix: true,
        ownerEmail: true,
        logoUrl: true,
        status: true,
        createdAt: true,
        subscriptions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { plan: true, status: true, trialEndsAt: true },
        },
      },
    });
    return { organization };
  }

  @Patch("current")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Roles(Role.ADMIN, Role.HR)
  async updateCurrentOrganization(
    @CurrentUser() user: { organizationId: string },
    @Body() dto: { name?: string; logoUrl?: string; employeePrefix?: string },
  ) {
    if (!user.organizationId) {
      throw new NotFoundException("No organization associated with this account.");
    }
    const updated = await this.prisma.organization.update({
      where: { id: user.organizationId },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.employeePrefix ? { employeePrefix: dto.employeePrefix.trim().toUpperCase() } : {}),
      },
      select: { id: true, name: true, slug: true, logoUrl: true, employeePrefix: true },
    });
    return { organization: updated };
  }

  @Patch("platform/:id")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Roles(Role.PLATFORM_ADMIN)
  async updateForPlatform(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateOrganizationDto) {
    const organization = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.organization.findUnique({ where: { id }, select: { id: true } });
      if (!existing) return null;
      if (dto.status) await tx.organization.update({ where: { id }, data: { status: dto.status } });
      if (dto.plan || dto.subscriptionStatus) {
        const current = await tx.organizationSubscription.findFirst({ where: { organizationId: id }, orderBy: { createdAt: "desc" } });
        if (current) await tx.organizationSubscription.update({ where: { id: current.id }, data: { plan: dto.plan ?? current.plan, status: dto.subscriptionStatus ?? current.status } });
        else await tx.organizationSubscription.create({ data: { organizationId: id, plan: dto.plan ?? SubscriptionPlan.STARTER, status: dto.subscriptionStatus ?? SubscriptionStatus.TRIALING } });
      }
      return tx.organization.findUnique({ where: { id }, select: { id: true, name: true, slug: true, emailDomain: true, status: true } });
    });
    if (!organization) throw new NotFoundException("Organization not found.");
    return { organization };
  }
}

