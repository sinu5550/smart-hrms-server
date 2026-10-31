const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const { authenticateToken, requireRoles, requirePermissions, resolveClientIp } = require("../middleware");

function createOrganizationsRouter(prisma) {
  const router = express.Router();

  // GET /api/organizations/my-ip - Returns detected public IP of caller as seen by server
  router.get("/my-ip", (req, res) => {
    const ip = resolveClientIp(req);
    return res.status(200).json({ ip });
  });

  async function generateEmployeePrefix(name) {
    const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
    const base = (words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] || "ORG").slice(0, 3)).slice(0, 5) || "ORG";
    let candidate = base;
    for (
      let suffix = 1;
      await prisma.organization.findUnique({ where: { employeePrefix: candidate }, select: { id: true } });
      suffix++
    ) {
      candidate = `${base.slice(0, 5 - String(suffix).length)}${suffix}`;
    }
    return candidate;
  }

  // POST /api/organizations/register (Public)
  router.post("/register", async (req, res, next) => {
    try {
      const dto = req.body || {};
      const email = (dto.ownerEmail || "").trim().toLowerCase();
      const domain = email.split("@")[1]?.toLowerCase();
      if (!domain || domain === "localhost") {
        return res.status(400).json({ message: "Enter a valid email address." });
      }

      const verificationRequired = process.env.EMAIL_VERIFICATION_ENABLED === "true";
      const smtpHost = process.env.SMTP_HOST;
      const smtpUser = process.env.SMTP_USER;
      const smtpPassword = process.env.SMTP_PASSWORD;
      const from = process.env.SMTP_FROM;

      if (verificationRequired && (!smtpHost || !smtpUser || !smtpPassword || !from)) {
        return res.status(503).json({
          message: "Organization signup needs SMTP email verification configured by the platform administrator.",
        });
      }

      const existingUser = await prisma.user.findFirst({ where: { email }, select: { id: true } });
      if (existingUser) {
        return res.status(409).json({
          message: "This email already has an organization account. Sign in or use a different email address.",
        });
      }

      const token = verificationRequired ? crypto.randomBytes(32).toString("base64url") : null;
      const tokenHash = token ? crypto.createHash("sha256").update(token).digest("hex") : null;
      const expiresAt = token ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;
      const tenantId = crypto.randomUUID();
      const slug = tenantId;
      const employeePrefix = await generateEmployeePrefix(dto.name || "ORG");
      const ownerEmployeeId = crypto.randomUUID();
      const passwordHash = await bcrypt.hash(dto.password, 12);

      let org;
      try {
        org = await prisma.$transaction(async (tx) => {
          return tx.organization.create({
            data: {
              id: tenantId,
              name: (dto.name || "").trim(),
              slug,
              emailDomain: domain,
              ownerEmail: email,
              employeePrefix,
              status: verificationRequired ? "PENDING_VERIFICATION" : "TRIAL",
              domainVerifiedAt: verificationRequired ? null : new Date(),
              verificationTokenHash: tokenHash,
              verificationExpiresAt: expiresAt,
              users: {
                create: {
                  employeeId: ownerEmployeeId,
                  email,
                  passwordHash,
                  fullName: (dto.ownerName || "").trim(),
                  role: "OWNER",
                  mustChangePassword: false,
                },
              },
              subscriptions: {
                create: {
                  plan: "STARTER",
                  status: "TRIALING",
                  trialEndsAt: new Date(Date.now() + 14 * 86400000),
                },
              },
              officeSettings: {
                create: {
                  shiftName: "Standard Day Shift",
                  startTime: "09:00",
                  endTime: "18:00",
                  gracePeriodMinutes: 30,
                  isDefault: true,
                },
              },
            },
            select: { id: true, name: true, slug: true, emailDomain: true, employeePrefix: true },
          });
        });
      } catch (error) {
        if (error && typeof error === "object" && error.code === "P2002") {
          return res.status(409).json({
            message: "This email is already registered. Sign in or use a different email address.",
          });
        }
        throw error;
      }

      if (verificationRequired && token) {
        const appUrl = (process.env.TENANT_APP_URL || "http://localhost:3000").replace(/\/$/, "");
        const link = `${appUrl}/verify-organization?token=${encodeURIComponent(token)}`;
        try {
          await nodemailer.createTransport({
            host: smtpHost,
            port: Number(process.env.SMTP_PORT || 587),
            secure: process.env.SMTP_SECURE === "true",
            auth: { user: smtpUser, pass: smtpPassword },
          }).sendMail({
            from,
            to: email,
            subject: `Verify your ${org.name} HRMS account`,
            text: `Verify your email address with this link (expires in 24 hours): ${link}`,
            html: `<p>Verify your email address to activate <b>${org.name}</b>.</p><p><a href="${link}">Verify email address</a></p><p>This link expires in 24 hours.</p>`,
          });
        } catch {
          await prisma.organization.delete({ where: { id: org.id } }).catch(() => undefined);
          return res.status(503).json({
            message: "We could not send the verification email. Ask the platform administrator to check SMTP settings and retry signup.",
          });
        }
      }

      return res.status(201).json({
        message: verificationRequired
          ? "Organization created. Check your email to verify the address before signing in."
          : "Organization is ready. You can now sign in to your workspace.",
        verificationRequired,
        organization: { id: org.id, name: org.name, employeePrefix: org.employeePrefix },
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/organizations/verify (Public)
  router.get("/verify", async (req, res, next) => {
    try {
      const { token } = req.query;
      if (!token || token.length > 200) {
        return res.status(400).json({ message: "Verification token is invalid or expired." });
      }

      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const organization = await prisma.organization.findFirst({
        where: {
          verificationTokenHash: tokenHash,
          verificationExpiresAt: { gt: new Date() },
          status: "PENDING_VERIFICATION",
        },
        select: { id: true },
      });

      if (!organization) {
        return res.status(400).json({ message: "Verification token is invalid or expired." });
      }

      await prisma.organization.update({
        where: { id: organization.id },
        data: {
          domainVerifiedAt: new Date(),
          status: "TRIAL",
          verificationTokenHash: null,
          verificationExpiresAt: null,
        },
      });

      return res.status(200).json({ message: "Organization email verified. You can now sign in to your workspace." });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/organizations/current (Authenticated)
  router.get("/current", authenticateToken, async (req, res, next) => {
    try {
      if (!req.user.organizationId) {
        return res.status(200).json({ organization: null });
      }

      const organization = await prisma.organization.findUnique({
        where: { id: req.user.organizationId },
        select: {
          id: true,
          name: true,
          slug: true,
          emailDomain: true,
          employeePrefix: true,
          ownerEmail: true,
          logoUrl: true,
          address: true,
          weekendDays: true,
          hasRosterDuty: true,
          rosterDepartmentIds: true,
          status: true,
          createdAt: true,
          subscriptions: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { plan: true, status: true, trialEndsAt: true },
          },
        },
      });

      return res.status(200).json({ organization });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/organizations/current (Authenticated, ADMIN or HR)
  router.patch("/current", authenticateToken, requireRoles("ADMIN", "HR"), async (req, res, next) => {
    try {
      if (!req.user.organizationId) {
        return res.status(404).json({ message: "No organization associated with this account." });
      }

      const dto = req.body || {};
      const updated = await prisma.organization.update({
        where: { id: req.user.organizationId },
        data: {
          ...(dto.name ? { name: dto.name.trim() } : {}),
          ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
          ...(dto.employeePrefix ? { employeePrefix: dto.employeePrefix.trim().toUpperCase() } : {}),
          ...(dto.address !== undefined ? { address: dto.address ? dto.address.trim() : null } : {}),
          ...(dto.weekendDays !== undefined ? { weekendDays: dto.weekendDays } : {}),
          ...(dto.hasRosterDuty !== undefined ? { hasRosterDuty: Boolean(dto.hasRosterDuty) } : {}),
          ...(dto.rosterDepartmentIds !== undefined ? { rosterDepartmentIds: dto.rosterDepartmentIds } : {}),
        },
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          employeePrefix: true,
          address: true,
          weekendDays: true,
          hasRosterDuty: true,
          rosterDepartmentIds: true,
        },
      });

      return res.status(200).json({ organization: updated });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/organizations/networks (Owner/Admin or devices.wifi / devices.view)
  router.get("/networks", authenticateToken, requirePermissions(prisma, "devices.wifi"), async (req, res, next) => {
    try {
      if (!req.user.organizationId) {
        return res.status(404).json({ message: "No organization associated." });
      }

      const networks = await prisma.officeNetwork.findMany({
        where: { organizationId: req.user.organizationId },
        orderBy: { createdAt: "desc" },
      });

      return res.status(200).json(networks);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/organizations/networks (Owner/Admin or devices.wifi)
  router.post("/networks", authenticateToken, requirePermissions(prisma, "devices.wifi"), async (req, res, next) => {
    try {
      const { locationName, allowedPublicIp, subnetMask } = req.body || {};
      const organizationId = req.user.organizationId;

      if (!organizationId) {
        return res.status(403).json({ message: "Organization workspace required." });
      }
      if (!allowedPublicIp || !allowedPublicIp.trim()) {
        return res.status(400).json({ message: "Allowed Wi-Fi IP address is required." });
      }

      const cleanIp = allowedPublicIp.trim();
      const existing = await prisma.officeNetwork.findFirst({
        where: { organizationId, allowedPublicIp: cleanIp },
      });

      if (existing) {
        return res.status(400).json({ message: `Wi-Fi IP ${cleanIp} is already registered.` });
      }

      const network = await prisma.officeNetwork.create({
        data: {
          organizationId,
          locationName: (locationName || "Office HQ Wi-Fi").trim(),
          allowedPublicIp: cleanIp,
          subnetMask: subnetMask ? subnetMask.trim() : null,
          isActive: true,
        },
      });

      return res.status(201).json(network);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/organizations/networks/:id (Owner/Admin or devices.wifi)
  router.delete("/networks/:id", authenticateToken, requirePermissions(prisma, "devices.wifi"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const organizationId = req.user.organizationId;

      const network = await prisma.officeNetwork.findFirst({
        where: { id, organizationId },
      });

      if (!network) {
        return res.status(404).json({ message: "Network entry not found." });
      }

      await prisma.officeNetwork.delete({ where: { id } });
      return res.status(200).json({ success: true, message: "Office Wi-Fi IP rule removed." });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/organizations/platform (PLATFORM_ADMIN only)
  router.get("/platform", authenticateToken, requireRoles("PLATFORM_ADMIN"), async (req, res, next) => {
    try {
      const [organizations, total, active, pending] = await prisma.$transaction([
        prisma.organization.findMany({
          select: {
            id: true,
            name: true,
            slug: true,
            emailDomain: true,
            ownerEmail: true,
            logoUrl: true,
            status: true,
            domainVerifiedAt: true,
            createdAt: true,
            subscriptions: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { plan: true, status: true, trialEndsAt: true, currentPeriodEnd: true },
            },
            _count: { select: { users: true } },
          },
          orderBy: { createdAt: "desc" },
        }),
        prisma.organization.count(),
        prisma.organization.count({ where: { status: { in: ["TRIAL", "ACTIVE"] } } }),
        prisma.organization.count({ where: { status: "PENDING_VERIFICATION" } }),
      ]);

      return res.status(200).json({ summary: { total, active, pending }, organizations });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/organizations/platform/:id (PLATFORM_ADMIN only)
  router.patch("/platform/:id", authenticateToken, requireRoles("PLATFORM_ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const dto = req.body || {};

      const organization = await prisma.$transaction(async (tx) => {
        const existing = await tx.organization.findUnique({ where: { id }, select: { id: true } });
        if (!existing) return null;

        if (dto.status) {
          await tx.organization.update({ where: { id }, data: { status: dto.status } });
        }

        if (dto.plan || dto.subscriptionStatus) {
          const current = await tx.organizationSubscription.findFirst({
            where: { organizationId: id },
            orderBy: { createdAt: "desc" },
          });
          if (current) {
            await tx.organizationSubscription.update({
              where: { id: current.id },
              data: {
                plan: dto.plan ?? current.plan,
                status: dto.subscriptionStatus ?? current.status,
              },
            });
          } else {
            await tx.organizationSubscription.create({
              data: {
                organizationId: id,
                plan: dto.plan ?? "STARTER",
                status: dto.subscriptionStatus ?? "TRIALING",
              },
            });
          }
        }

        return tx.organization.findUnique({
          where: { id },
          select: { id: true, name: true, slug: true, emailDomain: true, status: true },
        });
      });

      if (!organization) {
        return res.status(404).json({ message: "Organization not found." });
      }

      return res.status(200).json({ organization });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createOrganizationsRouter };
