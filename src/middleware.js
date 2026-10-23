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
  officeIpGuard,
};
