import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { PrismaService } from "../../prisma/prisma.service";

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  organizationId: string | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>("JWT_SECRET"),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        organizationId: true,
        employeeId: true,
        email: true,
        role: true,
        status: true,
        isDeleted: true,
      },
    });

    if (!user || user.isDeleted) {
      throw new UnauthorizedException(
        "Account not found or has been deactivated.",
      );
    }

    if (["RESIGNED", "TERMINATED", "SUSPENDED"].includes(user.status)) {
      throw new UnauthorizedException(
        "Account access revoked due to employment status change.",
      );
    }

    if (user.organizationId) {
      const organization = await this.prisma.organization.findUnique({ where: { id: user.organizationId }, select: { status: true, domainVerifiedAt: true } });
      if (!organization || !organization.domainVerifiedAt || !["TRIAL", "ACTIVE"].includes(organization.status)) {
        throw new UnauthorizedException("Organization is unavailable or its subscription is inactive.");
      }
      const subscription = await this.prisma.organizationSubscription.findFirst({ where: { organizationId: user.organizationId }, orderBy: { createdAt: "desc" } });
      if (subscription && (!["TRIALING", "ACTIVE"].includes(subscription.status) || (subscription.status === "TRIALING" && subscription.trialEndsAt && subscription.trialEndsAt < new Date()))) {
        throw new UnauthorizedException("Organization subscription is inactive.");
      }
    }

    return {
      userId: user.id,
      employeeId: user.employeeId,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
    };
  }
}
