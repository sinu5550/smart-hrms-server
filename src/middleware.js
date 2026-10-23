const jwt = require("jsonwebtoken");

function resolveClientIp(req) {
  const xForwardedFor = req.headers["x-forwarded-for"];
  let rawIp = "";

  if (typeof xForwardedFor === "string") {
    rawIp = xForwardedFor.split(",")[0].trim();
  } else if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    rawIp = xForwardedFor[0].trim();
  } else {
    rawIp = req.ip || req.socket?.remoteAddress || "";
  }

  if (rawIp.startsWith("::ffff:")) {
    rawIp = rawIp.slice(7);
  }

  return rawIp === "::1" ? "127.0.0.1" : rawIp;
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Unauthorized: Missing authentication token." });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { userId, email, role, organizationId }
    next();
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized: Invalid or expired token." });
  }
}

function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (allowedRoles.length && !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden: Insufficient privileges." });
    }
    next();
  };
}

function requirePermissions(prisma, requiredPermission) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Platform admin and Workspace Admin/Owner always have full privileges
    if (req.user.role === "PLATFORM_ADMIN" || req.user.role === "ADMIN") {
      return next();
    }

    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: {
          role: true,
          permissions: true,
          customRole: { select: { permissions: true } },
          organization: { select: { ownerEmail: true } },
        },
      });

      if (!user) {
        return res.status(401).json({ message: "User profile not found." });
      }

      // Check if user is the organization owner
      if (user.organization?.ownerEmail && user.organization.ownerEmail.toLowerCase() === req.user.email.toLowerCase()) {
        return next();
      }

      // Collect user permissions (direct + customRole)
      const directPermissions = Array.isArray(user.permissions) ? user.permissions : [];
      const rolePermissions = Array.isArray(user.customRole?.permissions) ? user.customRole.permissions : [];
      const userPermissions = Array.from(new Set([...directPermissions, ...rolePermissions]));

      if (!userPermissions.includes(requiredPermission)) {
        return res.status(403).json({
          message: `Access denied: You do not possess the "${requiredPermission}" privilege.`,
        });
      }

      next();
    } catch (err) {
      console.error("Permission check error:", err);
      return res.status(500).json({ message: "Internal authorization error." });
    }
  };
}

async function officeIpGuard(prisma, req, res, next) {
  const organizationId = req.user?.organizationId;
  if (!organizationId) {
    return res.status(403).json({ message: "Attendance requires an organization workspace." });
  }

  if (process.env.BYPASS_IP_CHECK === "true") {
    return next();
  }

  const clientIp = resolveClientIp(req);
  if (!clientIp) {
    return res.status(403).json({ message: "Network origin undetermined." });
  }

  try {
    const network = await prisma.officeNetwork.findFirst({
      where: {
        organizationId,
        allowedPublicIp: clientIp,
        isActive: true,
      },
      select: { id: true, locationName: true },
    });

    if (!network) {
      return res.status(403).json({
        message: `Access blocked: Attendance and break actions must occur on Office Wi-Fi. Current IP: ${clientIp}`,
      });
    }

    next();
  } catch (err) {
    console.error("Office IP check error:", err);
    return res.status(500).json({ message: "Internal verification error" });
  }
}

module.exports = {
  resolveClientIp,
  authenticateToken,
  requireRoles,
  requirePermissions,
  officeIpGuard,
};
