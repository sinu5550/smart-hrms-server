const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { authenticateToken } = require("../middleware");
const { createAndSendOtp, verifyOtp } = require("../otp.service");

function createAuthRouter(prisma) {
  const router = express.Router();

  async function issueSession(user, organizationId) {
    const payload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      organizationId,
    };

    // 30-day session lifespan for employee mobile attendance & sliding sessions
    const sessionLifespan = "30d";

    const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: sessionLifespan,
    });

    const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
      expiresIn: sessionLifespan,
    });

    const refreshTokenHash = await bcrypt.hash(refreshToken, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash },
    });

    let organizationData = null;
    if (organizationId) {
      organizationData = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, name: true, slug: true, logoUrl: true, employeePrefix: true, ownerEmail: true },
      });
    }

    // Merge direct permissions and customRole permissions
    let activePermissions = Array.isArray(user.permissions) ? user.permissions : [];
    if (user.customRoleId) {
      const cr = await prisma.customRole.findUnique({ where: { id: user.customRoleId }, select: { permissions: true } });
      if (cr && Array.isArray(cr.permissions)) {
        activePermissions = Array.from(new Set([...activePermissions, ...cr.permissions]));
      }
    }

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
        attendanceExempt: Boolean(user.attendanceExempt),
        isOwner: user.role === "OWNER" || (organizationData?.ownerEmail && user.email?.toLowerCase() === organizationData.ownerEmail.toLowerCase()),
        status: user.status,
        avatarUrl: user.avatarUrl,
        permissions: activePermissions,
        customRoleId: user.customRoleId,
        organization: organizationData,
      },
    };
  }

  // POST /api/auth/send-otp
  router.post("/send-otp", async (req, res, next) => {
    try {
      const { email, type } = req.body || {};
      if (!email) {
        return res.status(400).json({ message: "Email address is required." });
      }

      await createAndSendOtp(email, type || "sign-in");
      return res.status(200).json({ success: true, message: `OTP code dispatched to ${email}.` });
    } catch (err) {
      console.error("send-otp error:", err);
      next(err);
    }
  });

  // POST /api/auth/verify-otp
  router.post("/verify-otp", async (req, res, next) => {
    try {
      const { email, otp, type } = req.body || {};
      if (!email || !otp) {
        return res.status(400).json({ message: "Email and OTP code are required." });
      }

      const result = await verifyOtp(email, otp);
      if (!result.valid) {
        return res.status(400).json({ message: result.message || "Invalid or expired OTP." });
      }

      const user = await prisma.user.findFirst({
        where: { email: email.trim().toLowerCase(), isDeleted: false },
        include: { organization: true },
      });

      if (user && type === "sign-in") {
        const session = await issueSession(user, user.organizationId);
        return res.status(200).json({ success: true, verified: true, session });
      }

      return res.status(200).json({ success: true, verified: true, message: "OTP verified successfully." });
    } catch (err) {
      console.error("verify-otp error:", err);
      next(err);
    }
  });

  // POST /api/auth/login
  router.post("/login", async (req, res, next) => {
    try {
      const { identifier, password } = req.body || {};
      if (!identifier || !password) {
        return res.status(400).json({ message: "Identifier and password are required." });
      }

      const trimmedIdentifier = identifier.trim();
      const users = await prisma.user.findMany({
        where: {
          isDeleted: false,
          OR: [{ email: trimmedIdentifier.toLowerCase() }, { employeeId: trimmedIdentifier }],
        },
        include: {
          organization: {
            include: { subscriptions: { orderBy: { createdAt: "desc" }, take: 1 } },
          },
        },
        take: 3,
      });

      if (!users.length) {
        return res.status(401).json({ message: "Invalid credentials." });
      }
      if (users.length > 1) {
        return res.status(401).json({
          message: "This login ID is ambiguous. Sign in with your employee ID or contact HR.",
        });
      }

      const user = users[0];
      const organization = user.organization;
      if (!organization || !organization.domainVerifiedAt || !["TRIAL", "ACTIVE"].includes(organization.status)) {
        return res.status(401).json({
          message: "Organization is unavailable or its email is not verified.",
        });
      }

      const subscription = organization.subscriptions[0];
      if (subscription && !["TRIALING", "ACTIVE"].includes(subscription.status)) {
        return res.status(403).json({
          message: "Organization subscription is not active. Contact your organization administrator.",
        });
      }
      if (
        subscription?.status === "TRIALING" &&
        subscription.trialEndsAt &&
        subscription.trialEndsAt < new Date()
      ) {
        return res.status(403).json({
          message: "Organization trial has ended. Contact the platform administrator to continue.",
        });
      }

      if (["RESIGNED", "TERMINATED", "SUSPENDED"].includes(user.status)) {
        return res.status(401).json({ message: "Account access has been revoked. Contact HR." });
      }

      const isPasswordMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isPasswordMatch) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      const session = await issueSession(user, organization.id);
      return res.status(200).json(session);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/auth/platform-login
  router.post("/platform-login", async (req, res, next) => {
    try {
      const { identifier, password } = req.body || {};
      if (!identifier || !password) {
        return res.status(400).json({ message: "Identifier and password are required." });
      }

      const user = await prisma.user.findFirst({
        where: {
          organizationId: null,
          role: "PLATFORM_ADMIN",
          email: identifier.toLowerCase().trim(),
          isDeleted: false,
        },
      });

      if (
        !user ||
        user.status !== "ACTIVE" ||
        !(await bcrypt.compare(password, user.passwordHash))
      ) {
        return res.status(401).json({ message: "Invalid platform administrator credentials." });
      }

      const session = await issueSession(user, null);
      return res.status(200).json(session);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/auth/refresh
  router.post("/refresh", async (req, res, next) => {
    try {
      const { refreshToken } = req.body || {};
      if (!refreshToken) {
        return res.status(400).json({ message: "Refresh token is required." });
      }

      let payload;
      try {
        payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      } catch {
        return res.status(401).json({ message: "Invalid or expired refresh token." });
      }

      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
      });

      if (!user || user.isDeleted || !user.refreshTokenHash) {
        return res.status(401).json({ message: "Refresh session invalid." });
      }

      const isValid = await bcrypt.compare(refreshToken, user.refreshTokenHash);
      if (!isValid) {
        return res.status(401).json({ message: "Refresh token has been revoked." });
      }

      const newPayload = {
        userId: user.id,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId,
      };

      // Sliding session renewal: extend for another 30 days
      const sessionLifespan = "30d";

      const newAccessToken = jwt.sign(newPayload, process.env.JWT_SECRET, {
        expiresIn: sessionLifespan,
      });

      const newRefreshToken = jwt.sign(newPayload, process.env.JWT_REFRESH_SECRET, {
        expiresIn: sessionLifespan,
      });

      const newRefreshHash = await bcrypt.hash(newRefreshToken, 10);
      await prisma.user.update({
        where: { id: user.id },
        data: { refreshTokenHash: newRefreshHash },
      });

      return res.status(200).json({
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/auth/me
  router.get("/me", authenticateToken, async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: {
          id: true,
          organizationId: true,
          organization: { select: { id: true, name: true, slug: true, logoUrl: true, employeePrefix: true, ownerEmail: true } },
          employeeId: true,
          email: true,
          fullName: true,
          phone: true,
          role: true,
          status: true,
          bloodGroup: true,
          avatarUrl: true,
          permissions: true,
          customRoleId: true,
          attendanceExempt: true,
          customRole: { select: { id: true, name: true, permissions: true } },
          mustChangePassword: true,
          joiningDate: true,
          department: { select: { id: true, name: true } },
          designation: { select: { id: true, name: true } },
        },
      });

      if (!user) {
        return res.status(401).json({ message: "User profile not found." });
      }

      // Merge direct permissions and customRole permissions
      const directPerms = Array.isArray(user.permissions) ? user.permissions : [];
      const rolePerms = Array.isArray(user.customRole?.permissions) ? user.customRole.permissions : [];
      const mergedPermissions = Array.from(new Set([...directPerms, ...rolePerms]));

      return res.status(200).json({
        ...user,
        isOwner: user.role === "OWNER" || (user.organization?.ownerEmail && user.email?.toLowerCase() === user.organization.ownerEmail.toLowerCase()),
        permissions: mergedPermissions,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/auth/change-password
  router.post("/change-password", authenticateToken, async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "Current and new password are required." });
      }

      const user = await prisma.user.findFirst({
        where: { id: req.user.userId, organizationId: req.user.organizationId, isDeleted: false },
      });

      if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
        return res.status(401).json({ message: "Current password is incorrect." });
      }

      if (currentPassword === newPassword) {
        return res.status(403).json({ message: "Choose a new password different from your current password." });
      }

      const passwordHash = await bcrypt.hash(newPassword, 12);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: false, refreshTokenHash: null },
      });

      return res.status(200).json({ message: "Password changed. Sign in again with your new password." });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAuthRouter };
