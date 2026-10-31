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

  // ==========================================
  // EMPLOYEE SELF-REGISTRATION FORMS & SUBMISSIONS
  // ==========================================

  // 1. GET /api/organizations/public-form/:tenantSlug
  // Public endpoint for applicants to get basic org info, departments & designations
  router.get("/public-form/:tenantSlug", async (req, res, next) => {
    try {
      const { tenantSlug } = req.params;
      const org = await prisma.organization.findFirst({
        where: {
          OR: [{ slug: tenantSlug }, { id: tenantSlug }],
        },
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          address: true,
          employeePrefix: true,
          departments: {
            select: { id: true, name: true, code: true },
            orderBy: { name: "asc" },
          },
          designations: {
            select: { id: true, name: true, code: true },
            orderBy: { name: "asc" },
          },
        },
      });

      if (!org) {
        return res.status(404).json({ message: "Organization registration form not found or inactive." });
      }

      return res.status(200).json({ organization: org });
    } catch (err) {
      next(err);
    }
  });

  // 2. POST /api/organizations/public-form/:tenantSlug/submit
  // Public endpoint for prospective employees to submit their details
  router.post("/public-form/:tenantSlug/submit", async (req, res, next) => {
    try {
      const { tenantSlug } = req.params;
      const dto = req.body || {};

      const org = await prisma.organization.findFirst({
        where: {
          OR: [{ slug: tenantSlug }, { id: tenantSlug }],
        },
        select: { id: true },
      });

      if (!org) {
        return res.status(404).json({ message: "Organization registration form not found." });
      }

      const fullName = (dto.fullName || "").trim();
      const email = (dto.email || "").trim().toLowerCase();
      const phone = (dto.phone || "").trim();
      const password = (dto.password || "").trim();

      if (!fullName) {
        return res.status(400).json({ message: "Full Name is required." });
      }
      if (!email || !email.includes("@")) {
        return res.status(400).json({ message: "A valid Email address is required." });
      }
      if (!phone) {
        return res.status(400).json({ message: "Phone number is required." });
      }
      if (!dto.dateOfBirth) {
        return res.status(400).json({ message: "Date of Birth is required." });
      }
      if (!dto.gender) {
        return res.status(400).json({ message: "Gender is required." });
      }
      if (!dto.bloodGroup) {
        return res.status(400).json({ message: "Blood Group is required." });
      }
      if (!dto.departmentId) {
        return res.status(400).json({ message: "Department is required." });
      }
      if (!dto.presentAddress) {
        return res.status(400).json({ message: "Present Address is required." });
      }
      if (!dto.emergencyContactName || !dto.emergencyContactPhone || !dto.emergencyContactRelation) {
        return res.status(400).json({ message: "All Emergency Contact fields are required." });
      }
      if (!password || password.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters long." });
      }

      // Check if user already exists as active employee
      const existingUser = await prisma.user.findFirst({
        where: {
          organizationId: org.id,
          OR: [
            { email },
            ...(phone ? [{ phone }] : []),
          ],
        },
      });

      if (existingUser) {
        return res.status(409).json({ message: "An employee with this email or phone is already enlisted." });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const registration = await prisma.employeeRegistration.create({
        data: {
          organizationId: org.id,
          fullName,
          email,
          phone: phone || null,
          nidOrPassport: dto.nidOrPassport || null,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null,
          gender: dto.gender || null,
          bloodGroup: dto.bloodGroup || null,
          presentAddress: dto.presentAddress || null,
          permanentAddress: dto.permanentAddress || null,
          emergencyContactName: dto.emergencyContactName || null,
          emergencyContactPhone: dto.emergencyContactPhone || null,
          emergencyContactRelation: dto.emergencyContactRelation || null,
          departmentId: dto.departmentId || null,
          designationId: dto.designationId || null,
          avatarUrl: dto.avatarUrl || null,
          passwordHash,
          status: "PENDING",
        },
      });

      return res.status(201).json({
        success: true,
        message: "Registration submitted successfully! HR will review and provision your employee account.",
        registrationId: registration.id,
      });
    } catch (err) {
      next(err);
    }
  });

  // 3. GET /api/organizations/registrations
  // Protected endpoint for Owner / Authorized HR to view pending employee registrations
  router.get("/registrations", authenticateToken, async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const userRole = req.user.role;
      const userPerms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
      const isOwner = userRole === "OWNER" || userRole === "PLATFORM_ADMIN" || req.user.isOwner;
      const canManage = isOwner || userRole === "ADMIN" || userRole === "HR" || userPerms.includes("employees.create") || userPerms.includes("employees.registration");

      if (!canManage) {
        return res.status(403).json({ message: "You do not have permission to view employee registrations." });
      }

      const { status } = req.query;
      const whereClause = { organizationId };
      if (status) {
        whereClause.status = status;
      }

      const list = await prisma.employeeRegistration.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" },
      });

      // Enrich with department and designation names
      const [departments, designations] = await Promise.all([
        prisma.department.findMany({ where: { organizationId }, select: { id: true, name: true } }),
        prisma.designation.findMany({ where: { organizationId }, select: { id: true, name: true } }),
      ]);

      const deptMap = new Map(departments.map((d) => [d.id, d.name]));
      const desigMap = new Map(designations.map((d) => [d.id, d.name]));

      const enriched = list.map((item) => ({
        ...item,
        departmentName: item.departmentId ? deptMap.get(item.departmentId) || null : null,
        designationName: item.designationId ? desigMap.get(item.designationId) || null : null,
      }));

      return res.status(200).json({ registrations: enriched });
    } catch (err) {
      next(err);
    }
  });

  // 4. PATCH /api/organizations/registrations/:id/status
  // Reject or mark registration as handled
  router.patch("/registrations/:id/status", authenticateToken, async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const userRole = req.user.role;
      const userPerms = Array.isArray(req.user.permissions) ? req.user.permissions : [];
      const isOwner = userRole === "OWNER" || userRole === "PLATFORM_ADMIN" || req.user.isOwner;
      const canManage = isOwner || userRole === "ADMIN" || userRole === "HR" || userPerms.includes("employees.create") || userPerms.includes("employees.registration");

      if (!canManage) {
        return res.status(403).json({ message: "Access denied." });
      }

      const { id } = req.params;
      const { status } = req.body || {};

      const updated = await prisma.employeeRegistration.updateMany({
        where: { id, organizationId },
        data: { status: status || "ENLISTED" },
      });

      return res.status(200).json({ success: true, count: updated.count });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createOrganizationsRouter };
