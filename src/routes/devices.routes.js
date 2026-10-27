const express = require("express");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const QRCode = require("qrcode");
const { authenticateToken, requireRoles, requirePermissions } = require("../middleware");

function createDevicesRouter(prisma) {
  const router = express.Router();

  // Helper to compute a secure HMAC QR payload for an organization
  function computeTenantQrPayload(organizationId, organizationSlug, allowedPublicIp) {
    const secret = process.env.JWT_SECRET || "hrms_secret";
    // We bind the QR payload to tenant organizationId, slug, and optional office public IP
    const rawData = `tenant:${organizationId}:slug:${organizationSlug || ""}:ip:${allowedPublicIp || "any"}`;
    const signature = crypto.createHmac("sha256", secret).update(rawData).digest("hex");
    return JSON.stringify({
      type: "OFFICE_ATTENDANCE_QR",
      orgId: organizationId,
      slug: organizationSlug,
      officeIp: allowedPublicIp || null,
      sig: signature,
      timestamp: Date.now(),
    });
  }

  // GET /api/devices/qr-code (Admin, HR with devices.qr or devices.view)
  router.get("/qr-code", authenticateToken, requirePermissions(prisma, "devices.qr"), async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, name: true, slug: true, employeePrefix: true, logoUrl: true },
      });

      if (!org) {
        return res.status(404).json({ message: "Organization not found." });
      }

      // Check configured office networks
      const networks = await prisma.officeNetwork.findMany({
        where: { organizationId, isActive: true },
        select: { id: true, locationName: true, allowedPublicIp: true },
      });

      const primaryIp = networks.length > 0 ? networks[0].allowedPublicIp : "127.0.0.1";
      const qrPayload = computeTenantQrPayload(org.id, org.slug, primaryIp);

      // Generate Data URL PNG
      const qrDataUrl = await QRCode.toDataURL(qrPayload, {
        errorCorrectionLevel: "H",
        margin: 2,
        width: 400,
        color: {
          dark: "#064e3b", // Emerald dark
          light: "#ffffff",
        },
      });

      return res.status(200).json({
        organization: org,
        officeNetworks: networks,
        primaryIp,
        qrPayload,
        qrDataUrl,
        staticOfficeSecret: process.env.OFFICE_QR_SECRET || "super_secure_office_static_token_2026",
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/devices (Admin, HR with devices.view)
  router.get("/", authenticateToken, requirePermissions(prisma, "devices.view"), async (req, res, next) => {
    try {
      const devices = await prisma.biometricDevice.findMany({
        where: { organizationId: req.user.organizationId },
        orderBy: { createdAt: "desc" },
      });
      return res.status(200).json(devices);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/devices (Admin, HR with devices.manage)
  router.post("/", authenticateToken, requirePermissions(prisma, "devices.manage"), async (req, res, next) => {
    try {
      const dto = req.body || {};
      const organizationId = req.user.organizationId;

      const existing = await prisma.biometricDevice.findFirst({
        where: { organizationId, deviceSerialNumber: dto.deviceSerialNumber },
      });
      if (existing) {
        return res.status(400).json({
          message: `Device with serial number "${dto.deviceSerialNumber}" is already registered.`,
        });
      }

      const created = await prisma.biometricDevice.create({
        data: {
          organizationId,
          deviceName: dto.deviceName,
          deviceSerialNumber: dto.deviceSerialNumber,
          deviceModel: dto.deviceModel || "Hikvision Face & Fingerprint Terminal",
          ipAddress: dto.ipAddress || null,
          port: dto.port ? Number(dto.port) : 80,
          username: dto.username || "admin",
          password: dto.password || null,
          locationName: dto.locationName || "Main Entrance Gate",
          status: "ONLINE",
          lastHeartbeat: new Date(),
        },
      });

      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/devices/:id (Admin, HR with devices.manage)
  router.delete("/:id", authenticateToken, requirePermissions(prisma, "devices.manage"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const organizationId = req.user.organizationId;

      const device = await prisma.biometricDevice.findFirst({
        where: { id, organizationId },
      });
      if (!device) {
        return res.status(404).json({ message: "Device not found." });
      }

      const deleted = await prisma.biometricDevice.delete({ where: { id } });
      return res.status(200).json(deleted);
    } catch (err) {
      next(err);
    }
  });

  // Helper to compute HTTP Digest Auth header
  function buildDigestHeader(method, uri, user, pass, authHeader) {
    const parts = {};
    authHeader.replace(/^Digest\s+/, "").split(/,\s*/).forEach(p => {
      const idx = p.indexOf("=");
      if (idx !== -1) {
        parts[p.slice(0, idx).trim()] = p.slice(idx + 1).replace(/"/g, "").trim();
      }
    });

    const realm = parts.realm || "";
    const nonce = parts.nonce || "";
    const qop = parts.qop || "";
    const cnonce = crypto.randomBytes(8).toString("hex");
    const nc = "00000001";

    const ha1 = crypto.createHash("md5").update(`${user}:${realm}:${pass}`).digest("hex");
    const ha2 = crypto.createHash("md5").update(`${method}:${uri}`).digest("hex");
    if (qop.includes("auth")) {
      const response = crypto.createHash("md5").update(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`).digest("hex");
      return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
    } else {
      const response = crypto.createHash("md5").update(`${ha1}:${nonce}:${ha2}`).digest("hex");
      return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
    }
  }

  // GET /api/devices/:id/snapshot (Live camera frame proxy)
  router.get("/:id/snapshot", authenticateToken, requirePermissions(prisma, "devices.view"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const device = await prisma.biometricDevice.findFirst({
        where: { id, organizationId: req.user.organizationId },
      });

      if (!device || !device.ipAddress) {
        return res.status(404).json({ message: "Device not found or IP address not configured." });
      }

      const user = device.username || "admin";
      const pass = device.password || "";
      const host = device.ipAddress;
      const isHttps = true; // Hikvision standard secure port 443
      const port = 443;
      const path = "/ISAPI/Streaming/channels/101/picture";

      const client = isHttps ? https : http;
      const opts = {
        hostname: host,
        port,
        path,
        method: "GET",
        rejectUnauthorized: false,
        timeout: 5000,
      };

      const req1 = client.request(opts, (res1) => {
        if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
          const auth = res1.headers["www-authenticate"];
          const digestHeader = buildDigestHeader("GET", path, user, pass, auth);

          const req2 = client.request(
            { ...opts, headers: { Authorization: digestHeader } },
            (res2) => {
              if (res2.statusCode !== 200) {
                return res.status(res2.statusCode).json({ message: "Device camera authentication failed or channel unreachable." });
              }
              res.setHeader("Content-Type", res2.headers["content-type"] || "image/jpeg");
              res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
              res2.pipe(res);
            }
          );

          req2.on("error", (err) => {
            console.error("Camera proxy sub-request error:", err.message);
            res.status(502).json({ message: "Failed to fetch camera snapshot from device." });
          });
          req2.end();
        } else if (res1.statusCode === 200) {
          res.setHeader("Content-Type", res1.headers["content-type"] || "image/jpeg");
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res1.pipe(res);
        } else {
          res.status(res1.statusCode).json({ message: `Device returned status: ${res1.statusCode}` });
        }
      });

      req1.on("error", (err) => {
        console.error("Camera proxy connection error:", err.message);
        res.status(504).json({ message: "Could not reach device on local network. Verify IP & Wi-Fi connection." });
      });

      req1.end();
    } catch (err) {
      next(err);
    }
  });

  // GET /api/devices/logs (Admin, HR with devices.view)
  router.get("/logs", authenticateToken, requirePermissions(prisma, "devices.view"), async (req, res, next) => {
    try {
      const logs = await prisma.biometricRawLog.findMany({
        where: { organizationId: req.user.organizationId },
        orderBy: { punchTime: "desc" },
        take: 50,
        include: {
          device: { select: { deviceName: true, locationName: true } },
        },
      });
      return res.status(200).json(logs);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/devices/webhook/push-log (Public hardware push webhook for Hikvision & ZKTeco)
  router.post("/webhook/push-log", async (req, res, next) => {
    try {
      const dto = req.body || {};

      // 1. Normalize device serial from Hikvision ISAPI XML/JSON or standard payload
      // Hikvision sends: { eventType, AccessControllerEvent: { deviceNo, subEventType, employeeNoString, ... } }
      // Or: { deviceSerialNumber, employeeId, punchTime, verificationMode }
      const serialNumber =
        dto.deviceSerialNumber ||
        dto.AccessControllerEvent?.deviceNo ||
        dto.AccessControllerEvent?.serialNo ||
        dto.serialNo ||
        dto.macAddress;

      const employeeId =
        dto.employeeId ||
        dto.AccessControllerEvent?.employeeNoString ||
        dto.AccessControllerEvent?.cardNo ||
        dto.cardNo;

      let punchTime = dto.punchTime || dto.AccessControllerEvent?.time || dto.dateTime;
      punchTime = punchTime ? new Date(punchTime) : new Date();

      // Determine verification method (Hikvision subEventType or verificationMode)
      let verificationMode = dto.verificationMode || "FINGERPRINT";
      if (dto.AccessControllerEvent) {
        const subType = Number(dto.AccessControllerEvent?.subEventType || 0);
        // In Hikvision: 75=Face match passed, 38=Fingerprint match passed, 1=Card swipe
        if (subType === 75 || dto.AccessControllerEvent?.faceLib) {
          verificationMode = "FACE_SCAN";
        } else if (subType === 38 || dto.AccessControllerEvent?.fingerPrint) {
          verificationMode = "FINGERPRINT";
        } else {
          verificationMode = "HIKVISION_BIOMETRIC";
        }
      }

      if (!serialNumber || !employeeId) {
        return res.status(400).json({
          message: "Missing deviceSerialNumber or employee identifier in webhook payload.",
        });
      }

      // 2. Locate device
      const device = await prisma.biometricDevice.findFirst({
        where: { deviceSerialNumber: String(serialNumber).trim() },
      });

      if (!device || !device.organizationId) {
        return res.status(404).json({
          message: `Unregistered hardware device serial: ${serialNumber}`,
        });
      }

      // 3. Find user in the same organization (by employeeId or national ID/card)
      const cleanEmpId = String(employeeId).trim();
      const user = await prisma.user.findFirst({
        where: {
          organizationId: device.organizationId,
          OR: [
            { employeeId: cleanEmpId },
            { employeeId: { endsWith: cleanEmpId } },
          ],
        },
      });

      if (!user) {
        return res.status(404).json({
          message: `Employee ID "${cleanEmpId}" not found in workspace organization.`,
        });
      }

      const punchDate = punchTime;
      const utcMidnightToday = new Date(
        Date.UTC(punchDate.getUTCFullYear(), punchDate.getUTCMonth(), punchDate.getUTCDate())
      );

      // 4. Record raw punch
      await prisma.biometricRawLog.create({
        data: {
          organizationId: device.organizationId,
          deviceId: device.id,
          deviceSerialNumber: String(serialNumber).trim(),
          employeeId: user.employeeId,
          punchTime: punchDate,
          punchType: dto.punchType || "CHECK_IN",
          verificationMode,
          syncStatus: "PROCESSED",
        },
      });

      // 4. Update device heartbeat & sync counter
      await prisma.biometricDevice.update({
        where: { id: device.id },
        data: {
          lastHeartbeat: new Date(),
          totalLogsSynced: { increment: 1 },
          status: "ONLINE",
        },
      });

      // 5. Auto sync to Attendance ledger
      const existingAttendance = await prisma.attendance.findUnique({
        where: {
          userId_date: {
            userId: user.id,
            date: utcMidnightToday,
          },
        },
      });

      if (!existingAttendance) {
        await prisma.attendance.create({
          data: {
            organizationId: device.organizationId,
            userId: user.id,
            date: utcMidnightToday,
            checkInTime: punchDate,
            currentState: "CHECKED_IN",
            status: "PRESENT",
            ipAddress: device.ipAddress || "BIOMETRIC_HARDWARE",
            punchInDeviceType: "BIOMETRIC_TERMINAL",
            punchInAddress: device.locationName,
          },
        });
      } else if (existingAttendance.currentState !== "CHECKED_OUT") {
        const elapsedMinutes = Math.max(
          0,
          Math.round((punchDate.getTime() - existingAttendance.checkInTime.getTime()) / (1000 * 60))
        );
        const totalWorkMinutes = Math.max(
          0,
          elapsedMinutes - existingAttendance.totalBreakMinutes
        );

        await prisma.attendance.update({
          where: { id: existingAttendance.id },
          data: {
            checkOutTime: punchDate,
            currentState: "CHECKED_OUT",
            totalWorkMinutes,
            punchOutAddress: device.locationName,
          },
        });
      }

      return res.status(200).json({ success: true, message: "Punch log processed successfully" });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createDevicesRouter };
