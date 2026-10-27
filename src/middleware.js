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
    // PLATFORM_ADMIN always has full access
    if (req.user.role === "PLATFORM_ADMIN") {
      return next();
    }
    // OWNER has full access to workspace resources (unless it's strictly platform-only)
    if (req.user.role === "OWNER" && !allowedRoles.every(r => r === "PLATFORM_ADMIN")) {
      return next();
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

    // Platform admin, Workspace Owner, and Workspace Admin always have full privileges
    if (req.user.role === "PLATFORM_ADMIN" || req.user.role === "OWNER" || req.user.role === "ADMIN") {
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

function ipToInt(ip) {
  if (!ip || typeof ip !== "string") return null;
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (isNaN(n) || n < 0 || n > 255 || parts[i].trim() === "") return null;
    num = (num << 8) + n;
  }
  return num >>> 0;
}

function maskToInt(mask) {
  if (!mask || typeof mask !== "string") return null;
  const cleanMask = mask.trim().replace(/^\//, "");
  if (/^\d+$/.test(cleanMask)) {
    const bits = parseInt(cleanMask, 10);
    if (bits < 0 || bits > 32) return null;
    if (bits === 0) return 0;
    return ((0xffffffff << (32 - bits)) >>> 0);
  }
  return ipToInt(cleanMask);
}

function isIpAllowed(clientIp, allowedPublicIp, subnetMask) {
  if (!clientIp || !allowedPublicIp) return false;
  const cleanClient = clientIp.trim();
  let cleanAllowed = allowedPublicIp.trim();

  // Handle localhost variations
  const isLocalClient = cleanClient === "127.0.0.1" || cleanClient === "::1" || cleanClient === "localhost";
  const isLocalAllowed = cleanAllowed === "127.0.0.1" || cleanAllowed === "::1" || cleanAllowed === "localhost";
  if (isLocalClient && isLocalAllowed) return true;

  // Direct exact match
  if (cleanClient === cleanAllowed) return true;

  // Check if allowedPublicIp contains CIDR notation (e.g., 45.248.148.0/24)
  let effectiveMask = subnetMask ? subnetMask.trim() : null;
  if (cleanAllowed.includes("/")) {
    const [ipPart, cidrPart] = cleanAllowed.split("/");
    cleanAllowed = ipPart.trim();
    if (!effectiveMask) effectiveMask = cidrPart.trim();
  }

  // If no subnet mask specified, check exact match
  if (!effectiveMask) {
    return cleanClient === cleanAllowed;
  }

  const clientInt = ipToInt(cleanClient);
  const allowedInt = ipToInt(cleanAllowed);
  const maskInt = maskToInt(effectiveMask);

  if (clientInt === null || allowedInt === null || maskInt === null) {
    return cleanClient === cleanAllowed;
  }

  return ((clientInt & maskInt) >>> 0) === ((allowedInt & maskInt) >>> 0);
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
    const networks = await prisma.officeNetwork.findMany({
      where: {
        organizationId,
        isActive: true,
      },
      select: { id: true, locationName: true, allowedPublicIp: true, subnetMask: true },
    });

    const matchedNetwork = networks.find((net) =>
      isIpAllowed(clientIp, net.allowedPublicIp, net.subnetMask)
    );

    if (!matchedNetwork) {
      return res.status(403).json({
        message: `Access blocked: Attendance and break actions must occur on Office Wi-Fi. Current IP: ${clientIp}`,
      });
    }

    req.officeNetwork = matchedNetwork;
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
  isIpAllowed,
  ipToInt,
  maskToInt,
};
