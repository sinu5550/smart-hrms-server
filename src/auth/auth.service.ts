import { ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { EmploymentStatus, Role } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { ChangePasswordDto, LoginDto, PlatformLoginDto } from "./dto/auth.dto";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    const identifier = dto.identifier.trim();
    const users = await this.prisma.user.findMany({
      where: { isDeleted: false, OR: [{ email: identifier.toLowerCase() }, { employeeId: identifier }] },
      include: { organization: { include: { subscriptions: { orderBy: { createdAt: "desc" }, take: 1 } } } },
      take: 3,
    });
    if (!users.length) throw new UnauthorizedException("Invalid credentials.");
    if (users.length > 1) throw new UnauthorizedException("This login ID is ambiguous. Sign in with your employee ID or contact HR.");
    const user = users[0];
    const organization = user.organization;
    if (!organization || !organization.domainVerifiedAt || !["TRIAL", "ACTIVE"].includes(organization.status)) {
      throw new UnauthorizedException("Organization is unavailable or its email is not verified.");
    }
    const subscription = organization.subscriptions[0];
    if (subscription && !["TRIALING", "ACTIVE"].includes(subscription.status)) throw new ForbiddenException("Organization subscription is not active. Contact your organization administrator.");
    if (subscription?.status === "TRIALING" && subscription.trialEndsAt && subscription.trialEndsAt < new Date()) throw new ForbiddenException("Organization trial has ended. Contact the platform administrator to continue.");
    if (["RESIGNED", "TERMINATED", "SUSPENDED"].includes(user.status)) throw new UnauthorizedException("Account access has been revoked. Contact HR.");
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) throw new UnauthorizedException("Invalid credentials.");
    return this.issueSession(user, organization.id, organization.employeePrefix);
  }

  async platformLogin(dto: PlatformLoginDto) {
    const user = await this.prisma.user.findFirst({
      where: {
        organizationId: null,
        role: "PLATFORM_ADMIN",
        email: dto.identifier.toLowerCase().trim(),
        isDeleted: false,
      },
    });
    if (!user || user.status !== EmploymentStatus.ACTIVE || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException("Invalid platform administrator credentials.");
    }
    return this.issueSession(user, null);
  }

  private async issueSession(user: { id: string; email: string; employeeId: string; fullName: string; role: Role; status: EmploymentStatus; avatarUrl: string | null; mustChangePassword: boolean }, organizationId: string | null, employeePrefix?: string) {
    const payload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>("JWT_SECRET"),
      expiresIn: "1d",
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.getOrThrow<string>("JWT_REFRESH_SECRET"),
      expiresIn: "7d",
    });

    const refreshTokenHash = await bcrypt.hash(refreshToken, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash },
    });

    return {
      accessToken,
      refreshToken,
      mustChangePassword: user.mustChangePassword,
      organizationId,
      user: {
        id: user.id,
        employeeId: user.employeeId,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        status: user.status,
        avatarUrl: user.avatarUrl,
        organization: organizationId
          ? await this.prisma.organization.findUnique({
              where: { id: organizationId },
              select: { id: true, name: true, slug: true, logoUrl: true, employeePrefix: true },
            })
          : null,
      },
    };
  }

  async refreshTokens(currentRefreshToken: string) {
    let payload: { userId: string; email: string; role: string; organizationId: string | null };
    try {
      payload = this.jwtService.verify(currentRefreshToken, {
        secret: this.configService.getOrThrow<string>("JWT_REFRESH_SECRET"),
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token.");
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user || user.isDeleted || !user.refreshTokenHash) {
      throw new UnauthorizedException("Refresh session invalid.");
    }

    const isValid = await bcrypt.compare(
      currentRefreshToken,
      user.refreshTokenHash,
    );
    if (!isValid) {
      throw new UnauthorizedException("Refresh token has been revoked.");
    }

    const newPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
    };

    const newAccessToken = this.jwtService.sign(newPayload, {
      secret: this.configService.getOrThrow<string>("JWT_SECRET"),
      expiresIn: "1d",
    });

    const newRefreshToken = this.jwtService.sign(newPayload, {
      secret: this.configService.getOrThrow<string>("JWT_REFRESH_SECRET"),
      expiresIn: "7d",
    });

    const newRefreshHash = await bcrypt.hash(newRefreshToken, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash: newRefreshHash },
    });

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        organizationId: true,
        organization: { select: { id: true, name: true, slug: true, logoUrl: true, employeePrefix: true } },
        employeeId: true,
        email: true,
        fullName: true,
        phone: true,
        role: true,
        status: true,
        bloodGroup: true,
        avatarUrl: true,
        permissions: true,
        mustChangePassword: true,
        joiningDate: true,
        department: { select: { id: true, name: true } },
        designation: { select: { id: true, name: true } },
      },
    });

    if (!user) {
      throw new UnauthorizedException("User profile not found.");
    }

    return user;
  }

  async changePassword(userId: string, organizationId: string | null, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, organizationId, isDeleted: false } });
    if (!user || !(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      throw new UnauthorizedException("Current password is incorrect.");
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new ForbiddenException("Choose a new password different from your current password.");
    }
    const passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false, refreshTokenHash: null } });
    return { message: "Password changed. Sign in again with your new password." };
  }
}
