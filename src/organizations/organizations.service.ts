import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OrganizationStatus, Role, SubscriptionPlan, SubscriptionStatus } from "@prisma/client";
import * as bcrypt from "bcrypt";
import * as crypto from "crypto";
import nodemailer from "nodemailer";
import { PrismaService } from "../prisma/prisma.service";
import { SelfServiceRegistrationDto } from "./dto/register-organization.dto";

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  async register(dto: SelfServiceRegistrationDto) {
    const email = dto.ownerEmail.trim().toLowerCase();
    const domain = email.split("@")[1]?.toLowerCase();
    if (!domain || domain === "localhost") throw new BadRequestException("Enter a valid email address.");
    const verificationRequired = this.config.get<string>("EMAIL_VERIFICATION_ENABLED") === "true";
    const smtpHost = this.config.get<string>("SMTP_HOST");
    const smtpUser = this.config.get<string>("SMTP_USER");
    const smtpPassword = this.config.get<string>("SMTP_PASSWORD");
    const from = this.config.get<string>("SMTP_FROM");
    if (verificationRequired && (!smtpHost || !smtpUser || !smtpPassword || !from)) {
      throw new ServiceUnavailableException("Organization signup needs SMTP email verification configured by the platform administrator.");
    }
    if (await this.prisma.user.findFirst({ where: { email }, select: { id: true } })) {
      throw new ConflictException("This email already has an organization account. Sign in or use a different email address.");
    }

    const token = verificationRequired ? crypto.randomBytes(32).toString("base64url") : null;
    const tokenHash = token ? crypto.createHash("sha256").update(token).digest("hex") : null;
    const expiresAt = token ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;
    const tenantId = crypto.randomUUID();
    const slug = tenantId;
    const employeePrefix = await this.generateEmployeePrefix(dto.name);
    const ownerEmployeeId = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(dto.password, 12);
    let org: { id: string; name: string; slug: string; emailDomain: string; employeePrefix: string };
    try {
      org = await this.prisma.$transaction(async (tx) => {
      return tx.organization.create({
        data: {
          id: tenantId, name: dto.name.trim(), slug, emailDomain: domain, ownerEmail: email, employeePrefix,
          status: verificationRequired ? OrganizationStatus.PENDING_VERIFICATION : OrganizationStatus.TRIAL,
          domainVerifiedAt: verificationRequired ? null : new Date(),
          verificationTokenHash: tokenHash,
          verificationExpiresAt: expiresAt,
          users: { create: { employeeId: ownerEmployeeId, email, passwordHash, fullName: dto.ownerName.trim(), role: Role.ADMIN, mustChangePassword: false } },
          subscriptions: { create: { plan: SubscriptionPlan.STARTER, status: SubscriptionStatus.TRIALING, trialEndsAt: new Date(Date.now() + 14 * 86400000) } },
          officeSettings: { create: { shiftName: "Standard Day Shift", startTime: "09:00", endTime: "18:00", gracePeriodMinutes: 30, isDefault: true } },
        },
        select: { id: true, name: true, slug: true, emailDomain: true, employeePrefix: true },
      });
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
        throw new ConflictException("This email is already registered. Sign in or use a different email address.");
      }
      throw error;
    }
    if (verificationRequired && token) {
      const appUrl = (this.config.get<string>("TENANT_APP_URL") || "http://localhost:3000").replace(/\/$/, "");
      const link = `${appUrl}/verify-organization?token=${encodeURIComponent(token)}`;
      try {
        await nodemailer.createTransport({ host: smtpHost, port: Number(this.config.get<string>("SMTP_PORT") || 587), secure: this.config.get<string>("SMTP_SECURE") === "true", auth: { user: smtpUser, pass: smtpPassword } }).sendMail({ from, to: email, subject: `Verify your ${org.name} HRMS account`, text: `Verify your email address with this link (expires in 24 hours): ${link}`, html: `<p>Verify your email address to activate <b>${org.name}</b>.</p><p><a href="${link}">Verify email address</a></p><p>This link expires in 24 hours.</p>` });
      } catch {
        await this.prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
        throw new ServiceUnavailableException("We could not send the verification email. Ask the platform administrator to check SMTP settings and retry signup.");
      }
    }
    return {
      message: verificationRequired
        ? "Organization created. Check your email to verify the address before signing in."
        : "Organization is ready. You can now sign in to your workspace.",
      verificationRequired,
      organization: { id: org.id, name: org.name, employeePrefix: org.employeePrefix },
    };
  }

  private async generateEmployeePrefix(name: string) {
    const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
    const base = (words.length > 1 ? words.map((word) => word[0]).join("") : (words[0] || "ORG").slice(0, 3)).slice(0, 5) || "ORG";
    let candidate = base;
    for (let suffix = 1; await this.prisma.organization.findUnique({ where: { employeePrefix: candidate }, select: { id: true } }); suffix++) candidate = `${base.slice(0, 5 - String(suffix).length)}${suffix}`;
    return candidate;
  }

  async verify(token: string) {
    if (!token || token.length > 200) throw new BadRequestException("Verification token is invalid or expired.");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const organization = await this.prisma.organization.findFirst({ where: { verificationTokenHash: tokenHash, verificationExpiresAt: { gt: new Date() }, status: OrganizationStatus.PENDING_VERIFICATION }, select: { id: true } });
    if (!organization) throw new BadRequestException("Verification token is invalid or expired.");
    await this.prisma.organization.update({ where: { id: organization.id }, data: { domainVerifiedAt: new Date(), status: OrganizationStatus.TRIAL, verificationTokenHash: null, verificationExpiresAt: null } });
    return { message: "Organization email verified. You can now sign in to your workspace." };
  }
}
