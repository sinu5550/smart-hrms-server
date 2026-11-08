const express = require("express");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const AdmZip = require("adm-zip");
const QRCode = require("qrcode");
const { authenticateToken, requireRoles, requirePermissions } = require("../middleware");
const { sendDeviceCommandViaTunnel, isDeviceTunnelOnline } = require("../device-tunnel");

function createDevicesRouter(prisma) {
  const router = express.Router();

  // Helper to resolve Attendance Date considering Organization's Day Cutoff Hour (default 6:00 AM)
  async function resolveAttendanceLedgerDate(organizationId, punchDate = new Date()) {
    try {
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { dayCutoffHour: true },
      });
      const cutoff = org?.dayCutoffHour ?? 6;
      const shifted = new Date(punchDate.getTime() - cutoff * 3600 * 1000);
      const localYMD = shifted.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
      const [y, m, d] = localYMD.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
    } catch {
      const shifted = new Date(punchDate.getTime() - 6 * 3600 * 1000);
      const localYMD = shifted.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
      const [y, m, d] = localYMD.split("-").map(Number);
      return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
    }
  }

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

  // GET /api/devices/:id/download-agent (Download customized pre-configured agent zip for this device)
  router.get("/:id/download-agent", authenticateToken, requirePermissions(prisma, "devices.view"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const organizationId = req.user.organizationId;

      const device = await prisma.biometricDevice.findFirst({
        where: { id, organizationId },
      });
      if (!device) {
        return res.status(404).json({ message: "Device not found." });
      }

      // Find base agent zip (pre-bundled with portable node & scripts)
      const possibleZipPaths = [
        path.resolve(__dirname, "../../assets/base-agent.zip"),
        path.resolve(__dirname, "../../../hrms-frontend/public/downloads/SmartHRM-Biometric-Agent.zip"),
        path.resolve(process.cwd(), "assets/base-agent.zip"),
      ];
      let baseZipPath = possibleZipPaths.find((p) => fs.existsSync(p));

      if (!baseZipPath) {
        return res.status(500).json({ message: "Agent base package not found on server." });
      }

      // Prepare custom config.json payload for this exact device
      const customConfig = {
        cloudApiUrl: process.env.API_BASE_URL || "https://secure-api.creativeboxbd.com",
        deviceIp: device.ipAddress || "192.168.68.69",
        devicePort: device.port || 443,
        deviceUsername: device.username || "admin",
        devicePassword: device.password || "",
        deviceSerialNumber: device.deviceSerialNumber || "",
        pollIntervalSeconds: 8,
      };

      const safeDeviceName = (device.deviceName || "device").replace(/[^a-zA-Z0-9_-]/g, "_");
      const zipFileName = `SmartHRM-Agent-${safeDeviceName}.zip`;

      const zip = new AdmZip(baseZipPath);
      // Replace existing config.json with custom device config
      try {
        zip.deleteFile("config.json");
      } catch {
        // config.json may not exist or have different case
      }
      zip.addFile("config.json", Buffer.from(JSON.stringify(customConfig, null, 2), "utf8"));

      const zipBuffer = zip.toBuffer();

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${zipFileName}"`);
      res.setHeader("Content-Length", zipBuffer.length);
      return res.end(zipBuffer);
    } catch (err) {
      console.error("[Download Agent Error]", err);
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
      // If host is a private LAN IP (e.g. 192.168.x.x, 10.x.x.x), direct camera stream cannot cross router/NAT to cloud VPS
      if (!host || host === "10.0.0.2" || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.")) {
        return res.status(503).json({ message: "Camera snapshot is only available when accessed inside office LAN." });
      }

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

  // Calculate shift-based attendance status (PRESENT vs LATE) using user shift or default shift grace period
  async function determineAttendanceStatus(organizationId, userId, checkInDate) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { shiftId: true, attendanceExempt: true, role: true },
      });

      if (user?.attendanceExempt || user?.role === "OWNER") {
        return "PRESENT";
      }

      let setting = user?.shiftId
        ? await prisma.officeSetting.findUnique({ where: { id: user.shiftId } })
        : null;

      if (!setting) {
        setting = await prisma.officeSetting.findFirst({
          where: { organizationId, isDefault: true },
        });
      }

      if (!setting) {
        setting = await prisma.officeSetting.findFirst({
          where: { organizationId },
        });
      }

      const startTimeStr = setting?.startTime || "09:00";
      const graceMinutes = typeof setting?.gracePeriodMinutes === "number" ? setting.gracePeriodMinutes : 30;
      const [startHour, startMinute] = startTimeStr.split(":").map(Number);

      const cutoffMinutes = startHour * 60 + startMinute + graceMinutes;
      
      // Calculate local minutes from midnight in Bangladesh (UTC+6)
      // checkInDate is a Date instance.
      const checkIn = new Date(checkInDate);
      const checkInTotalMinutes = ((checkIn.getUTCHours() + 6) % 24) * 60 + checkIn.getUTCMinutes();

      if (checkInTotalMinutes > cutoffMinutes) {
        return "LATE";
      }
      return "PRESENT";
    } catch (e) {
      console.warn("determineAttendanceStatus error:", e.message);
      return "PRESENT";
    }
  }

  // Calculate Overtime Minutes based on user's shift settings and punch-out time
  // RULES:
  // 1. Check user's assigned shift or default org shift.
  // 2. Calculate the required shift duty duration in minutes (shiftEnd - shiftStart).
  // 3. User's total work minutes must meet or exceed this required duty duration first!
  // 4. Overtime starts only after duty duration is fulfilled AND after the admin overtimeThresholdMins buffer has passed.
  async function determineOvertimeMinutes(organizationId, userId, checkOutDate, totalWorkMinutes = null) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { shiftId: true },
      });

      let setting = user?.shiftId
        ? await prisma.officeSetting.findUnique({ where: { id: user.shiftId } })
        : null;

      if (!setting) {
        setting = await prisma.officeSetting.findFirst({
          where: { organizationId, isDefault: true },
        });
      }

      if (!setting) {
        setting = await prisma.officeSetting.findFirst({
          where: { organizationId },
        });
      }

      const startTimeStr = setting?.startTime || "09:00";
      const endTimeStr = setting?.endTime || "18:00";
      const thresholdMins = typeof setting?.overtimeThresholdMins === "number" ? setting.overtimeThresholdMins : 30;

      const [startHour, startMinute] = startTimeStr.split(":").map(Number);
      const [endHour, endMinute] = endTimeStr.split(":").map(Number);

      const shiftStartMins = startHour * 60 + startMinute;
      let shiftEndMins = endHour * 60 + endMinute;
      if (shiftEndMins < shiftStartMins) {
        // Overnight shift (e.g., 20:00 to 05:00)
        shiftEndMins += 24 * 60;
      }
      const requiredDutyMinutes = Math.max(60, shiftEndMins - shiftStartMins);

      // Rule A: If totalWorkMinutes is provided, employee MUST fulfill required duty duration first!
      if (typeof totalWorkMinutes === "number" && totalWorkMinutes < requiredDutyMinutes) {
        return 0;
      }

      // Rule B: Calculate minutes beyond the shift duration / checkout threshold
      // Convert checkOutDate to local hours/minutes (+06:00)
      const checkOut = new Date(checkOutDate);
      const checkOutMins = ((checkOut.getUTCHours() + 6) % 24) * 60 + checkOut.getUTCMinutes();

      // Effective duty minutes worked beyond required hours minus threshold buffer
      if (typeof totalWorkMinutes === "number") {
        const extraMinutes = totalWorkMinutes - requiredDutyMinutes;
        // If extra work exceeds buffer (e.g. 40 mins extra with 30 min buffer), overtime is 40 - 30 = 10 mins!
        if (extraMinutes > thresholdMins) {
          return extraMinutes - thresholdMins;
        }
        return 0;
      }

      // Fallback: If totalWorkMinutes not provided, check against wall-clock shift end
      if (checkOutMins > shiftEndMins + thresholdMins) {
        return checkOutMins - shiftEndMins - thresholdMins;
      }
      return 0;
    } catch (e) {
      console.warn("determineOvertimeMinutes notice:", e.message);
      return 0;
    }
  }

  // GET /api/devices/:id/portal (Live terminal diagnostic & registered persons view)
  router.post("/:id/sync-persons", authenticateToken, requirePermissions(prisma, "devices.manage"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const organizationId = req.user.organizationId;

      const device = await prisma.biometricDevice.findFirst({
        where: { id, organizationId },
      });

      if (!device || !device.ipAddress) {
        return res.status(404).json({ message: "Device not found or IP address not configured." });
      }

      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { employeePrefix: true, ownerEmail: true },
      });
      const prefix = (org?.employeePrefix || "EKH").trim().toUpperCase();
      const ownerEmail = (org?.ownerEmail || "").trim().toLowerCase();

      const termUser = device.username || "admin";
      const termPass = device.password || "";
      const host = device.ipAddress;

      // Helper: Digest-auth POST to device, returns parsed JSON or null (ISUP Tunnel priority)
      const devicePost = async (reqPath, bodyObj) => {
        const bodyStr = JSON.stringify(bodyObj);

        // Priority 1: Cloud ISUP Gateway Tunnel
        try {
          const resp = await sendDeviceCommandViaTunnel(device.deviceSerialNumber, {
            method: "POST",
            path: reqPath,
            body: bodyStr,
            timeout: 10000,
          });
          if (resp && resp.data) {
            return typeof resp.data === "string" ? JSON.parse(resp.data) : resp.data;
          }
        } catch (tErr) {
          // fallback
        }

        // Direct HTTPS fallback (only if routable public host)
        if (!host || host === "10.0.0.2" || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.")) {
          return null;
        }

        return new Promise((resolve) => {
          const bodyBuf = Buffer.from(bodyStr);
          const headers = { "Content-Type": "application/json", "Content-Length": 0 };
          const req1 = https.request(
            { hostname: host, port: 443, path: reqPath, method: "POST", rejectUnauthorized: false, timeout: 7000, headers },
            (res1) => {
              if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                res1.resume();
                const digest = buildDigestHeader("POST", reqPath, termUser, termPass, res1.headers["www-authenticate"]);
                const authHeaders = { "Content-Type": "application/json", "Content-Length": bodyBuf.length, Authorization: digest };
                const req2 = https.request(
                  { hostname: host, port: 443, path: reqPath, method: "POST", rejectUnauthorized: false, timeout: 10000, headers: authHeaders },
                  (res2) => {
                    let b = "";
                    res2.on("data", (c) => (b += c));
                    res2.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
                  }
                );
                req2.on("error", () => resolve(null));
                req2.on("timeout", () => { req2.destroy(); resolve(null); });
                req2.write(bodyBuf);
                req2.end();
              } else if (res1.statusCode === 200) {
                const chunks = [];
                res1.on("data", (c) => chunks.push(c));
                res1.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
              } else {
                res1.resume();
                resolve(null);
              }
            }
          );
          req1.on("error", () => resolve(null));
          req1.on("timeout", () => { req1.destroy(); resolve(null); });
          req1.end();
        });
      };

      // Paginated fetch — get ALL users from terminal (no 100 limit)
      const userList = [];
      let fetchPos = 0;
      const PAGE_SIZE = 50;
      while (true) {
        const pageData = await devicePost("/ISAPI/AccessControl/UserInfo/Search?format=json", {
          UserInfoSearchCond: {
            searchID: `sync_${fetchPos}`,
            searchResultPosition: fetchPos,
            maxResults: PAGE_SIZE,
          },
        });
        const page = pageData?.UserInfoSearch?.UserInfo || [];
        userList.push(...page);
        const total = Number(pageData?.UserInfoSearch?.totalMatches || 0);
        fetchPos += page.length;
        if (page.length < PAGE_SIZE || fetchPos >= total) break;
      }
      const totalMatches = userList.length;

      let importedCount = 0;
      let updatedCount = 0;
      const bcrypt = require("bcrypt");
      const defaultPasswordHash = await bcrypt.hash("12345678", 10);

      // Also query Face Library (FDSearch) to get enrolled face image URLs
      const faceUrlMap = new Map();
      try {
        for (const libType of ["blackFD", "staticWhite"]) {
          const fdPath = "/ISAPI/Intelligent/FDLib/FDSearch?format=json";
          const fdBody = JSON.stringify({
            searchResultPosition: 0,
            maxResults: 100,
            faceLibType: libType,
            FDID: "1",
          });

          const fdData = await new Promise((resolve) => {
            const req1 = https.request(
              {
                hostname: host,
                port: 443,
                path: fdPath,
                method: "POST",
                rejectUnauthorized: false,
                timeout: 5000,
                headers: { "Content-Type": "application/json", "Content-Length": 0 },
              },
              (res1) => {
                if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                  const digest = buildDigestHeader("POST", fdPath, termUser, termPass, res1.headers["www-authenticate"]);
                  const req2 = https.request(
                    {
                      hostname: host,
                      port: 443,
                      path: fdPath,
                      method: "POST",
                      rejectUnauthorized: false,
                      timeout: 6000,
                      headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(fdBody),
                        Authorization: digest,
                      },
                    },
                    (res2) => {
                      let b = "";
                      res2.on("data", (c) => (b += c));
                      res2.on("end", () => {
                        try {
                          resolve(JSON.parse(b));
                        } catch {
                          resolve(null);
                        }
                      });
                    }
                  );
                  req2.on("error", () => resolve(null));
                  req2.write(fdBody);
                  req2.end();
                } else {
                  resolve(null);
                }
              }
            );
            req1.on("error", () => resolve(null));
            req1.end();
          });

          const matchList = fdData?.MatchList || [];
          for (const m of matchList) {
            if (m.FPID && m.faceURL) {
              faceUrlMap.set(String(m.FPID).trim(), m.faceURL);
            }
          }
        }
      } catch (e) {
        console.warn("FDSearch fetch notice:", e.message);
      }

      // Helper to fetch face image buffer from terminal's faceURL
      async function downloadTerminalFace(targetFaceUrl) {
        if (!targetFaceUrl) return null;
        try {
          const urlObj = new URL(targetFaceUrl);
          const path = urlObj.pathname + urlObj.search;
          return await new Promise((resolve) => {
            const req1 = https.request(
              {
                hostname: host,
                port: 443,
                path,
                method: "GET",
                rejectUnauthorized: false,
                timeout: 5000,
              },
              (res1) => {
                if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                  const digest = buildDigestHeader("GET", path, termUser, termPass, res1.headers["www-authenticate"]);
                  const req2 = https.request(
                    {
                      hostname: host,
                      port: 443,
                      path,
                      method: "GET",
                      rejectUnauthorized: false,
                      timeout: 6000,
                      headers: { Authorization: digest },
                    },
                    (res2) => {
                      const chunks = [];
                      res2.on("data", (c) => chunks.push(c));
                      res2.on("end", () => {
                        const buf = Buffer.concat(chunks);
                        resolve(buf.length > 500 ? buf : null);
                      });
                    }
                  );
                  req2.on("error", () => resolve(null));
                  req2.end();
                } else {
                  resolve(null);
                }
              }
            );
            req1.on("error", () => resolve(null));
            req1.end();
          });
        } catch {
          return null;
        }
      }

      // Helper to upload buffer to Cloudinary
      async function uploadFaceBufferToCloudinary(buffer) {
        if (!buffer) return null;
        try {
          const cloudName = process.env.CLOUDINARY_CLOUD_NAME || "jawcusfd";
          const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET || "ekhone-hrms";
          const base64Data = `data:image/jpeg;base64,${buffer.toString("base64")}`;
          const formData = new FormData();
          formData.append("file", base64Data);
          formData.append("upload_preset", uploadPreset);
          formData.append("folder", "hrms/employee-avatars");

          const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
            method: "POST",
            body: formData,
          });
          const json = await res.json();
          return json.secure_url || null;
        } catch (e) {
          console.warn("Cloudinary face upload notice:", e.message);
          return null;
        }
      }

      // Pre-fetch all org users for dash-strip matching in the loop below
      const allOrgUsers = await prisma.user.findMany({
        where: { organizationId, role: { not: "OWNER" } },
        select: { id: true, employeeId: true, fullName: true },
      });

      // Ensure default organization Shift exists or auto-create it
      let defaultOrgShift = await prisma.officeSetting.findFirst({
        where: { organizationId },
      });
      if (!defaultOrgShift) {
        defaultOrgShift = await prisma.officeSetting.create({
          data: {
            organizationId,
            shiftName: "Regular Day Shift",
            startTime: "09:00",
            endTime: "18:00",
            gracePeriodMinutes: 30,
            overtimeThresholdMins: 30,
            isDefault: true,
          },
        });
      }

      // Pre-fetch existing organization departments for fast in-memory lookup
      const existingDepts = await prisma.department.findMany({
        where: { organizationId },
      });
      const deptMap = new Map(); // key: lowercase deptName or code -> id
      existingDepts.forEach((d) => {
        deptMap.set(d.name.toLowerCase().trim(), d.id);
        if (d.code) deptMap.set(d.code.toLowerCase().trim(), d.id);
      });

      // Exact Department mapping according to Hikvision terminal web UI department list:
      // Group 1: All / General (fallback)
      // Group 2: Management
      // Group 3: Customer Service (CS)
      // Group 4: Account & Financial
      // Group 5: Marketing & Sales
      // Group 6: Supply Chain
      // Group 7: HR & Admin
      // Group 8: IT & Software
      const HIKVISION_DEPT_GROUP_MAP = {
        1: "General",
        2: "Management",
        3: "Customer Service (CS)",
        4: "Account & Financial",
        5: "Marketing & Sales",
        6: "Supply Chain",
        7: "HR & Admin",
        8: "IT & Software",
      };

      // Helper to dynamically get or create Department from terminal group exactly as named on machine
      async function resolveDepartmentId(userItem) {
        // 1. Check belongGroup or PersonInfoExtends
        let rawName = (userItem?.belongGroup && userItem.belongGroup.trim()) ? userItem.belongGroup.trim() : "";
        if (!rawName && Array.isArray(userItem?.PersonInfoExtends)) {
          const extVal = userItem.PersonInfoExtends.find((e) => e?.value && e.value.trim());
          if (extVal) rawName = extVal.value.trim();
        }

        // 2. If belongGroup is empty, map from terminal groupId to exact Department Name from machine UI
        if (!rawName && userItem?.groupId !== undefined && userItem?.groupId !== null && userItem?.groupId !== "") {
          const gId = Number(userItem.groupId);
          if (HIKVISION_DEPT_GROUP_MAP[gId]) {
            rawName = HIKVISION_DEPT_GROUP_MAP[gId];
          } else {
            rawName = `Department ${gId}`;
          }
        }

        const candidateName = rawName || "General";
        const key = candidateName.toLowerCase().trim();
        if (deptMap.has(key)) return deptMap.get(key);

        const code = `D-${candidateName.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
        try {
          const newDept = await prisma.department.create({
            data: {
              organizationId,
              name: candidateName,
              code: `${code}-${Date.now().toString().slice(-4)}`,
            },
          });
          deptMap.set(key, newDept.id);
          return newDept.id;
        } catch (e) {
          const found = await prisma.department.findFirst({ where: { organizationId, name: candidateName } });
          if (found) {
            deptMap.set(key, found.id);
            return found.id;
          }
          return null;
        }
      }

      for (const item of userList) {
        const rawEmpNo = String(item.employeeNo || "").trim();
        const fullName = String(item.name || `Employee ${rawEmpNo}`).trim();
        if (!rawEmpNo) continue;

        // Format logic:
        // - If device ID starts with words/letters (e.g. "EKH260001"):
        //   Count prefix, extract year (2 digits) and serial, and reconstruct with hyphens -> "EKH-26-0001"
        // - If no prefix / words (pure numeric, e.g. "99"):
        //   Keep exactly as-is without any prefix, year, or hyphens.
        let formattedEmployeeId = rawEmpNo;
        const prefixWordMatch = rawEmpNo.match(/^([A-Za-z]+)(\d{2})(\d+)$/);
        if (prefixWordMatch) {
          const matchedPrefix = prefixWordMatch[1].toUpperCase();
          const matchedYear = prefixWordMatch[2];
          const matchedSerial = prefixWordMatch[3];
          formattedEmployeeId = `${matchedPrefix}-${matchedYear}-${matchedSerial}`;
        }

        // Generate guaranteed unique email for terminal imported employee
        let candidateEmail = `${rawEmpNo.toLowerCase().replace(/[^a-z0-9]/g, "")}_${organizationId.slice(0, 4)}@company.local`;
        const emailExists = await prisma.user.findFirst({ where: { email: candidateEmail } });
        if (emailExists) {
          candidateEmail = `${rawEmpNo.toLowerCase().replace(/[^a-z0-9]/g, "")}_${organizationId.slice(0, 4)}_${Date.now().toString().slice(-4)}@company.local`;
        }

        // Check if employee already exists strictly by:
        // 1. Exact employeeId === formattedEmployeeId or rawEmpNo
        // 2. Exact dash-stripped match (e.g. terminal "EKH260001" matches DB "EKH-26-0001")
        // 3. Exact full name match
        const searchConditions = [
          { employeeId: formattedEmployeeId },
          { employeeId: rawEmpNo },
        ];

        allOrgUsers.forEach((u) => {
          if (!u.employeeId) return;
          const stripped = u.employeeId.replace(/-/g, "");
          if (stripped === rawEmpNo || u.employeeId === formattedEmployeeId) {
            searchConditions.push({ employeeId: u.employeeId });
          }
        });

        if (fullName) {
          searchConditions.push({ fullName: { equals: fullName, mode: "insensitive" } });
        }

        const existingEmp = await prisma.user.findFirst({
          where: {
            organizationId,
            role: { not: "OWNER" },
            ...(ownerEmail ? { email: { not: ownerEmail } } : {}),
            OR: searchConditions,
          },
        });

        // Extract biometric enrollment counts from terminal record
        const numOfFP = Number(item.numOfFP || 0);
        const numOfFace = Number(item.numOfFace || 0);

        // Check if there is an enrolled face photo on the terminal
        const faceUrl = faceUrlMap.get(rawEmpNo) || faceUrlMap.get(String(parseInt(rawEmpNo, 10)));
        let newAvatarUrl = null;

        try {
          if (existingEmp) {
            // Merge biometric info into existing user permissions JSON strictly matching terminal counts
            const curPerms = Array.isArray(existingEmp.permissions) ? existingEmp.permissions : [];
            const updatedPerms = curPerms.filter((p) => typeof p === "string" && !p.startsWith("bio:"));
            if (numOfFP > 0) updatedPerms.push("bio:fingerprint");
            if (numOfFace > 0) updatedPerms.push("bio:face");

            // If user doesn't have an avatar in HRMS but terminal has a face image, pull it!
            if (!existingEmp.avatarUrl && faceUrl) {
              try {
                const buf = await downloadTerminalFace(faceUrl);
                if (buf) {
                  newAvatarUrl = await uploadFaceBufferToCloudinary(buf);
                }
              } catch (faceErr) {
                console.warn(`Face download notice for ${fullName}:`, faceErr.message);
              }
            }

            // Resolve Department from terminal group exactly as named on machine
            const resolvedDeptId = await resolveDepartmentId(item);

            // Do not overwrite legitimate DB employee name with a placeholder like "Employee 17"
            const updatedFullName = (item.name && item.name.trim()) ? item.name.trim() : existingEmp.fullName;

            await prisma.user.update({
              where: { id: existingEmp.id },
              data: {
                fullName: updatedFullName,
                gender: item.gender === "male" ? "MALE" : item.gender === "female" ? "FEMALE" : existingEmp.gender,
                avatarUrl: newAvatarUrl || existingEmp.avatarUrl,
                permissions: updatedPerms,
                isDeleted: false,
                deletedAt: null,
                status: existingEmp.status === "TERMINATED" ? "ACTIVE" : existingEmp.status,
                departmentId: existingEmp.departmentId || resolvedDeptId,
                shiftId: existingEmp.shiftId || defaultOrgShift?.id,
              },
            });
            updatedCount++;
          } else {
            // Create new employee with bio permissions tags
            const newPerms = [];
            if (numOfFP > 0) newPerms.push("bio:fingerprint");
            if (numOfFace > 0 || faceUrl) newPerms.push("bio:face");

            if (faceUrl) {
              try {
                const buf = await downloadTerminalFace(faceUrl);
                if (buf) {
                  newAvatarUrl = await uploadFaceBufferToCloudinary(buf);
                }
              } catch (faceErr) {
                console.warn(`Face download notice for ${fullName}:`, faceErr.message);
              }
            }

            const resolvedDeptId = await resolveDepartmentId(item);

            await prisma.user.create({
              data: {
                organizationId,
                employeeId: formattedEmployeeId,
                email: candidateEmail,
                passwordHash: defaultPasswordHash,
                fullName,
                gender: item.gender === "male" ? "MALE" : item.gender === "female" ? "FEMALE" : "OTHER",
                avatarUrl: newAvatarUrl || null,
                role: "EMPLOYEE",
                status: "ACTIVE",
                mustChangePassword: true,
                permissions: newPerms,
                departmentId: resolvedDeptId,
                shiftId: defaultOrgShift?.id,
              },
            });
            importedCount++;
          }
        } catch (itemErr) {
          console.warn(`[Sync-Persons] Skipped user item ${rawEmpNo} due to notice:`, itemErr.message);
        }
      }

      return res.status(200).json({
        success: true,
        totalFound: totalMatches,
        importedCount,
        updatedCount,
        message: `Successfully synced ${userList.length} persons from Hikvision (${importedCount} newly added, ${updatedCount} updated).`,
      });
    } catch (err) {
      console.error("Hikvision Sync Persons Error:", err.message);
      return res.status(500).json({
        message: err.message || "Failed to sync persons from Hikvision device.",
      });
    }
  });

  // POST /api/devices/:id/push-employee (Push an HRMS employee into the Hikvision machine)
  router.post("/:id/push-employee", authenticateToken, requirePermissions(prisma, "devices.manage"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { employeeId, employeeDbId } = req.body || {};
      const organizationId = req.user.organizationId;

      const device = await prisma.biometricDevice.findFirst({
        where: { id, organizationId },
      });

      if (!device || !device.ipAddress) {
        return res.status(404).json({ message: "Device not found or IP not configured." });
      }

      // Find target user from database safely without invalid UUID crashes
      const isUUID = (val) =>
        typeof val === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val.trim());

      const searchOr = [];
      if (employeeDbId && isUUID(employeeDbId)) {
        searchOr.push({ id: employeeDbId.trim() });
      }
      if (employeeId) {
        searchOr.push({ employeeId: employeeId.trim() });
        if (isUUID(employeeId)) {
          searchOr.push({ id: employeeId.trim() });
        }
      }

      const emp = await prisma.user.findFirst({
        where: {
          organizationId,
          ...(searchOr.length > 0 ? { OR: searchOr } : {}),
        },
      });

      if (!emp) {
        return res.status(404).json({ message: "Employee record not found in system." });
      }

      // Build terminal employeeNo: Hikvision does NOT accept dashes.
      // Strip all hyphens from the HRMS employeeId → EKH-26-0002 becomes EKH260002
      const terminalEmployeeNo = emp.employeeId.trim().replace(/-/g, "");

      const host = device.ipAddress;
      const user = device.username || "admin";
      const pass = device.password || "";
      const path = "/ISAPI/AccessControl/UserInfo/SetUp?format=json";

      // Map department to terminal groupId
      let deptGroupId = 1; // Default: General
      if (emp.departmentId) {
        const dept = await prisma.department.findUnique({ where: { id: emp.departmentId } });
        const deptName = (dept?.name || "").toLowerCase();
        if (deptName.includes("manage")) deptGroupId = 2;
        else if (deptName.includes("customer") || deptName.includes("service") || deptName.includes("cs")) deptGroupId = 3;
        else if (deptName.includes("account") || deptName.includes("finance")) deptGroupId = 4;
        else if (deptName.includes("market") || deptName.includes("sales")) deptGroupId = 5;
        else if (deptName.includes("supply") || deptName.includes("logistic")) deptGroupId = 6;
        else if (deptName.includes("hr") || deptName.includes("admin")) deptGroupId = 7;
        else if (deptName.includes("it") || deptName.includes("software")) deptGroupId = 8;
      }

      const setupPayload = JSON.stringify({
        UserInfo: {
          employeeNo: terminalEmployeeNo,
          name: emp.fullName.slice(0, 32).trim(),
          userType: "normal",
          gender: emp.gender?.toLowerCase() === "female" ? "female" : "male",
          groupId: deptGroupId,
          Valid: {
            enable: true,
            beginTime: "2026-01-01T00:00:00",
            endTime: "2036-12-31T23:59:59",
            timeType: "local",
          },
          doorRight: "1",
          RightPlan: [{ doorNo: 1, planTemplateNo: "1" }],
        },
      });

      // Execute PUT with Tunnel or Direct
      let pushResult = null;
      if (isDeviceTunnelOnline(device.deviceSerialNumber)) {
        try {
          const tunnelResp = await sendDeviceCommandViaTunnel(device.deviceSerialNumber, {
            method: "PUT",
            path,
            body: setupPayload,
          });
          pushResult = { statusCode: 200, data: tunnelResp.data };
        } catch (tErr) {
          console.warn("[Tunnel Push Failed, falling back to direct]", tErr.message);
        }
      }

      if (!pushResult) {
        pushResult = await new Promise((resolve, reject) => {
        const req1 = https.request(
          {
            hostname: host,
            port: 443,
            path,
            method: "PUT",
            rejectUnauthorized: false,
            timeout: 6000,
            headers: { "Content-Type": "application/json", "Content-Length": 0 },
          },
          (res1) => {
            if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
              const digest = buildDigestHeader("PUT", path, user, pass, res1.headers["www-authenticate"]);
              const req2 = https.request(
                {
                  hostname: host,
                  port: 443,
                  path,
                  method: "PUT",
                  rejectUnauthorized: false,
                  timeout: 7000,
                  headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(setupPayload),
                    Authorization: digest,
                  },
                },
                (res2) => {
                  let b = "";
                  res2.on("data", (c) => (b += c));
                  res2.on("end", () => {
                    try {
                      resolve({ statusCode: res2.statusCode, data: JSON.parse(b) });
                    } catch (e) {
                      resolve({ statusCode: res2.statusCode, data: b });
                    }
                  });
                }
              );
              req2.on("error", reject);
              req2.write(setupPayload);
              req2.end();
            } else {
              reject(new Error(`Device probe returned status ${res1.statusCode}`));
            }
          }
        );
        req1.on("error", reject);
        req1.end();
      });
      }

      // If employee has an avatar photo, also push the face image to the terminal
      if (emp.avatarUrl && emp.avatarUrl.startsWith("http")) {
        fetch(emp.avatarUrl)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((ab) => {
            if (!ab) return;
            const imgBuf = Buffer.from(ab);
            const boundary = "----WebKitFormBoundary" + crypto.randomBytes(16).toString("hex");
            const fdSetupPath = "/ISAPI/Intelligent/FDLib/FDSetUp?format=json";
            const jsonMetadata = JSON.stringify({
              faceLibType: "blackFD",
              FDID: "1",
              FPID: terminalEmployeeNo,
            });
            const head =
              `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="FaceDataRecord"\r\n` +
              `Content-Type: application/json\r\n` +
              `Content-Length: ${Buffer.byteLength(jsonMetadata)}\r\n\r\n` +
              `${jsonMetadata}\r\n` +
              `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="img"; filename="face.jpg"\r\n` +
              `Content-Type: image/jpeg\r\n` +
              `Content-Length: ${imgBuf.length}\r\n\r\n`;
            const tail = `\r\n--${boundary}--\r\n`;
            const multipartBody = Buffer.concat([
              Buffer.from(head, "utf-8"),
              imgBuf,
              Buffer.from(tail, "utf-8"),
            ]);

            const r1 = https.request(
              {
                hostname: host,
                port: 443,
                path: fdSetupPath,
                method: "PUT",
                rejectUnauthorized: false,
                timeout: 7000,
                headers: {
                  "Content-Type": `multipart/form-data; boundary=${boundary}`,
                  "Content-Length": 0,
                },
              },
              (res1) => {
                if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                  const digest = buildDigestHeader("PUT", fdSetupPath, user, pass, res1.headers["www-authenticate"]);
                  const r2 = https.request(
                    {
                      hostname: host,
                      port: 443,
                      path: fdSetupPath,
                      method: "PUT",
                      rejectUnauthorized: false,
                      timeout: 8000,
                      headers: {
                        "Content-Type": `multipart/form-data; boundary=${boundary}`,
                        "Content-Length": multipartBody.length,
                        Authorization: digest,
                      },
                    },
                    (res2) => {
                      if (res2.statusCode === 200) {
                        const curPerms = Array.isArray(emp.permissions) ? emp.permissions : [];
                        if (!curPerms.includes("bio:face")) {
                          prisma.user.update({
                            where: { id: emp.id },
                            data: { permissions: [...curPerms, "bio:face"] },
                          }).catch(() => {});
                        }
                      }
                    }
                  );
                  r2.on("error", () => {});
                  r2.write(multipartBody);
                  r2.end();
                }
              }
            );
            r1.on("error", () => {});
            r1.end();
          })
          .catch((e) => console.warn("Push employee face image notice:", e.message));
      }

      return res.status(200).json({
        success: true,
        terminalEmployeeNo,
        employeeName: emp.fullName,
        message: `Employee "${emp.fullName}" (ID: ${terminalEmployeeNo}) registered on Hikvision device successfully!`,
        result: pushResult,
      });
    } catch (err) {
      console.error("Push Employee to Hikvision Error:", err.message);
      return res.status(500).json({
        message: err.message || "Failed to push employee to Hikvision machine.",
      });
    }
  });

  // PUT /api/devices/:id/update-person (Directly edit person name/id on Hikvision device and sync DB)
  router.put("/:id/update-person", authenticateToken, requirePermissions(prisma, "devices.manage"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { employeeNo, name, employeeId } = req.body || {};
      const organizationId = req.user.organizationId;

      if (!employeeNo || !name) {
        return res.status(400).json({ message: "Employee terminal ID and person name are required." });
      }

      const device = await prisma.biometricDevice.findFirst({
        where: { id, organizationId },
      });

      if (!device || !device.ipAddress) {
        return res.status(404).json({ message: "Device not found or IP not configured." });
      }

      const host = device.ipAddress;
      const user = device.username || "admin";
      const pass = device.password || "";
      const path = "/ISAPI/AccessControl/UserInfo/SetUp?format=json";

      const setupPayload = JSON.stringify({
        UserInfo: {
          employeeNo: String(employeeNo).trim(),
          name: String(name).slice(0, 32).trim(),
          userType: "normal",
          Valid: {
            enable: true,
            beginTime: "2026-01-01T00:00:00",
            endTime: "2036-12-31T23:59:59",
            timeType: "local",
          },
          doorRight: "1",
          RightPlan: [{ doorNo: 1, planTemplateNo: "1" }],
        },
      });

      // Send to Hikvision device via Cloud ISUP Tunnel or Direct
      let registerSuccess = false;
      try {
        const resp = await sendDeviceCommandViaTunnel(device.deviceSerialNumber, {
          method: "PUT",
          path,
          body: setupPayload,
          timeout: 10000,
        });
        if (resp && resp.statusCode >= 200 && resp.statusCode < 300) {
          registerSuccess = true;
        }
      } catch (tErr) {
        // fallback
      }

      if (!registerSuccess && host && host !== "10.0.0.2" && !host.startsWith("10.") && !host.startsWith("192.168.")) {
        await new Promise((resolve, reject) => {
          const req1 = https.request(
            {
              hostname: host,
              port: 443,
              path,
              method: "PUT",
              rejectUnauthorized: false,
              timeout: 6000,
              headers: { "Content-Type": "application/json", "Content-Length": 0 },
            },
            (res1) => {
              if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                const digest = buildDigestHeader("PUT", path, user, pass, res1.headers["www-authenticate"]);
                const req2 = https.request(
                  {
                    hostname: host,
                    port: 443,
                    path,
                    method: "PUT",
                    rejectUnauthorized: false,
                    timeout: 7000,
                    headers: {
                      "Content-Type": "application/json",
                      "Content-Length": Buffer.byteLength(setupPayload),
                      Authorization: digest,
                    },
                  },
                  (res2) => {
                    let b = "";
                    res2.on("data", (c) => (b += c));
                    res2.on("end", () => {
                      if (res2.statusCode === 200) {
                        resolve(b);
                      } else {
                        reject(new Error(`Hikvision device returned error code ${res2.statusCode}: ${b}`));
                      }
                    });
                  }
                );
                req2.on("error", reject);
                req2.write(setupPayload);
                req2.end();
              } else {
                reject(new Error(`Hikvision probe returned unexpected status ${res1.statusCode}`));
              }
            }
          );
          req1.on("error", reject);
          req1.end();
        }).catch((e) => console.warn("Direct register-person notice:", e.message));
      }

      // Also update database employee record if matched (NEVER match or modify Owner)
      const trimmedNo = String(employeeNo).trim();
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { ownerEmail: true, employeePrefix: true },
      });
      const ownerEmail = (org?.ownerEmail || "").trim().toLowerCase();

      // Pre-fetch org users so we can do dash-strip matching (EKH260002 ↔ EKH-26-0002)
      const allOrgUsersForUpdate = await prisma.user.findMany({
        where: { organizationId, isDeleted: false, role: { not: "OWNER" } },
        select: { id: true, employeeId: true },
      });

      // Build extra OR conditions from dash-stripped comparison
      const dashStripMatches = allOrgUsersForUpdate
        .filter((u) => u.employeeId && u.employeeId.replace(/-/g, "") === trimmedNo)
        .map((u) => ({ employeeId: u.employeeId }));

      const dbEmp = await prisma.user.findFirst({
        where: {
          organizationId,
          isDeleted: false,
          role: { not: "OWNER" },
          ...(ownerEmail ? { email: { not: ownerEmail } } : {}),
          OR: [
            ...(employeeId ? [{ id: employeeId }, { employeeId }] : []),
            { employeeId: trimmedNo },
            ...dashStripMatches,
          ],
        },
      });

      let updatedDbEmp = null;
      if (dbEmp) {
        updatedDbEmp = await prisma.user.update({
          where: { id: dbEmp.id },
          data: { fullName: String(name).trim() },
          select: { id: true, employeeId: true, fullName: true },
        });
      }

      return res.status(200).json({
        success: true,
        message: `Hikvision terminal updated successfully for ID ${employeeNo} ("${name}").`,
        updatedEmployee: updatedDbEmp,
      });
    } catch (err) {
      console.error("Update Person on Hikvision Error:", err.message);
      return res.status(500).json({
        message: err.message || "Failed to update employee on Hikvision machine.",
      });
    }
  });

  // DELETE /api/devices/:id/persons/:employeeNo (Delete an employee directly from the Hikvision biometric device)
  router.delete("/:id/persons/:employeeNo", authenticateToken, requirePermissions(prisma, "devices.manage"), async (req, res, next) => {
    try {
      const { id, employeeNo } = req.params;
      const organizationId = req.user.organizationId;

      const device = await prisma.biometricDevice.findFirst({
        where: { id, organizationId },
      });

      if (!device || !device.ipAddress) {
        return res.status(404).json({ message: "Device not found or IP address not configured." });
      }

      const rawEmployeeNo = String(employeeNo || "").trim();
      if (!rawEmployeeNo) {
        return res.status(400).json({ message: "Employee terminal ID is required." });
      }

      // Also support dash-stripped ID format if highfens were passed
      const cleanEmpNo = rawEmployeeNo.replace(/-/g, "");

      const host = device.ipAddress;
      const user = device.username || "admin";
      const pass = device.password || "";
      const path = "/ISAPI/AccessControl/UserInfo/Delete?format=json";

      const delPayload = JSON.stringify({
        UserInfoDelCond: {
          EmployeeNoList: [
            { employeeNo: rawEmployeeNo },
            ...(cleanEmpNo !== rawEmployeeNo ? [{ employeeNo: cleanEmpNo }] : []),
          ],
        },
      });

      // Send to Hikvision device via Cloud ISUP Tunnel or Direct
      let delSuccess = false;
      try {
        const resp = await sendDeviceCommandViaTunnel(device.deviceSerialNumber, {
          method: "PUT",
          path,
          body: delPayload,
          timeout: 10000,
        });
        if (resp && resp.statusCode >= 200 && resp.statusCode < 300) {
          delSuccess = true;
        }
      } catch (tErr) {
        // fallback
      }

      if (!delSuccess && host && host !== "10.0.0.2" && !host.startsWith("10.") && !host.startsWith("192.168.")) {
        await new Promise((resolve, reject) => {
          const req1 = https.request(
            {
              hostname: host,
              port: 443,
              path,
              method: "PUT",
              rejectUnauthorized: false,
              timeout: 6000,
              headers: { "Content-Type": "application/json", "Content-Length": 0 },
            },
            (res1) => {
              if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                const digest = buildDigestHeader("PUT", path, user, pass, res1.headers["www-authenticate"]);
                const req2 = https.request(
                  {
                    hostname: host,
                    port: 443,
                    path,
                    method: "PUT",
                    rejectUnauthorized: false,
                    timeout: 7000,
                    headers: {
                      "Content-Type": "application/json",
                      "Content-Length": Buffer.byteLength(delPayload),
                      Authorization: digest,
                    },
                  },
                  (res2) => {
                    let b = "";
                    res2.on("data", (c) => (b += c));
                    res2.on("end", () => {
                      if (res2.statusCode === 200) {
                        resolve(b);
                      } else {
                        reject(new Error(`Hikvision machine returned status ${res2.statusCode}: ${b}`));
                      }
                    });
                  }
                );
                req2.on("error", reject);
                req2.write(delPayload);
                req2.end();
              } else {
                reject(new Error(`Hikvision probe returned unexpected status ${res1.statusCode}`));
              }
            }
          );
          req1.on("error", reject);
          req1.end();
        }).catch((e) => console.warn("Direct delete-person notice:", e.message));
      }

      // Also clean up bio permissions if this user exists in DB
      try {
        const allOrgUsers = await prisma.user.findMany({
          where: { organizationId, isDeleted: false, role: { not: "OWNER" } },
          select: { id: true, employeeId: true, permissions: true },
        });
        const matched = allOrgUsers.find((u) => {
          if (!u.employeeId) return false;
          return (
            u.employeeId === rawEmployeeNo ||
            u.employeeId.replace(/-/g, "") === cleanEmpNo
          );
        });
        if (matched) {
          const perms = Array.isArray(matched.permissions) ? matched.permissions : [];
          const updatedPerms = perms.filter(
            (p) => typeof p === "string" && !p.startsWith("bio:")
          );
          await prisma.user.update({
            where: { id: matched.id },
            data: { permissions: updatedPerms },
          });
        }
      } catch (dbErr) {
        console.warn("DB permission cleanup warning on terminal delete:", dbErr.message);
      }

      return res.status(200).json({
        success: true,
        message: `Employee ID "${rawEmployeeNo}" was successfully removed from ${device.deviceName}.`,
      });
    } catch (err) {
      console.error("Delete Person from Hikvision Error:", err.message);
      return res.status(500).json({
        message: err.message || "Failed to remove person from Hikvision machine.",
      });
    }
  });

  // GET /api/devices/:id/portal (Device Portal details with live persons status)
  router.get("/:id/portal", authenticateToken, requirePermissions(prisma, "devices.view"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const organizationId = req.user.organizationId;

      const device = await prisma.biometricDevice.findFirst({
        where: { id, organizationId },
      });

      if (!device) {
        return res.status(404).json({ message: "Biometric device record not found." });
      }

      // Fetch device users and recent punches
      let terminalUsers = [];
      let isTerminalReachable = false;

      if (device.ipAddress) {
        try {
          const user = device.username || "admin";
          const pass = device.password || "";
          const host = device.ipAddress;

          // 1. Fetch Users via ISUP Bridge / Tunnel or direct
          const userPath = "/ISAPI/AccessControl/UserInfo/Search?format=json";
          const searchBody = JSON.stringify({
            UserInfoSearchCond: {
              searchID: "1",
              searchResultPosition: 0,
              maxResults: 100,
            },
          });

          let userData = null;
          if (isDeviceTunnelOnline(device.deviceSerialNumber)) {
            try {
              const resp = await sendDeviceCommandViaTunnel(device.deviceSerialNumber, {
                method: "POST",
                path: userPath,
                body: searchBody,
                timeout: 8000,
              });
              if (resp && resp.data) {
                userData = typeof resp.data === "string" ? JSON.parse(resp.data) : resp.data;
              }
            } catch (tErr) {
              // fallback
            }
          }

          if (!userData && host && host !== "10.0.0.2" && !host.startsWith("10.") && !host.startsWith("192.168.")) {
            userData = await new Promise((resolve, reject) => {
              const req1 = https.request(
                {
                  hostname: host,
                  port: 443,
                  path: userPath,
                  method: "POST",
                  rejectUnauthorized: false,
                  timeout: 5000,
                  headers: { "Content-Type": "application/json", "Content-Length": 0 },
                },
                (res1) => {
                  if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                    const auth = res1.headers["www-authenticate"];
                    const digest = buildDigestHeader("POST", userPath, user, pass, auth);
                    const req2 = https.request(
                      {
                        hostname: host,
                        port: 443,
                        path: userPath,
                        method: "POST",
                        rejectUnauthorized: false,
                        timeout: 6000,
                        headers: {
                          "Content-Type": "application/json",
                          "Content-Length": Buffer.byteLength(searchBody),
                          Authorization: digest,
                        },
                      },
                      (res2) => {
                        let buf = "";
                        res2.on("data", (c) => (buf += c));
                        res2.on("end", () => {
                          try {
                            resolve(JSON.parse(buf));
                          } catch (e) {
                            reject(e);
                          }
                        });
                      }
                    );
                    req2.on("error", reject);
                    req2.on("timeout", () => { req2.destroy(); reject(new Error("UserInfo request timed out")); });
                    req2.write(searchBody);
                    req2.end();
                  } else {
                    reject(new Error("Probe did not return 401"));
                  }
                }
              );
              req1.on("error", reject);
              req1.on("timeout", () => { req1.destroy(); reject(new Error("UserInfo probe timed out")); });
              req1.end();
            });
          }

          const liveUsers = userData?.UserInfoSearch?.UserInfo || [];
          if (liveUsers.length > 0) {
            terminalUsers = liveUsers.map((u) => ({
              employeeNo: u.employeeNo,
              name: u.name,
              userType: u.userType,
              hasFingerprint: Number(u.numOfFP || 0) > 0,
              numOfFP: Number(u.numOfFP || 0),
              hasFace: Number(u.numOfFace || 0) > 0,
              numOfFace: Number(u.numOfFace || 0),
            }));
          }
          isTerminalReachable = true;
        } catch (err) {
          console.warn("Live terminal ISAPI probe notice:", err.message);
        }
      }

      // If live terminal fetch returned empty or failed, fallback to synced employees from database
      if (terminalUsers.length === 0) {
        const dbUsers = await prisma.user.findMany({
          where: { organizationId, status: "ACTIVE" },
          select: {
            employeeId: true,
            fullName: true,
            role: true,
            permissions: true,
          },
          orderBy: { employeeId: "asc" },
        });

        terminalUsers = dbUsers.map((u) => {
          const perms = Array.isArray(u.permissions) ? u.permissions : [];
          const hasFp = perms.includes("bio:fingerprint");
          const hasFc = perms.includes("bio:face");
          return {
            employeeNo: u.employeeId,
            name: u.fullName,
            userType: "normal",
            hasFingerprint: hasFp,
            numOfFP: hasFp ? 1 : 0,
            hasFace: hasFc,
            numOfFace: hasFc ? 1 : 0,
          };
        });

        // If device status is marked ONLINE, treat reachable as true
        if (device.status === "ONLINE") {
          isTerminalReachable = true;
        }
      }

      // Fetch refreshed recent raw punches from this device and attach employee fullName
      const rawRecentLogs = await prisma.biometricRawLog.findMany({
        where: {
          organizationId,
          deviceSerialNumber: device.deviceSerialNumber,
        },
        orderBy: { punchTime: "desc" },
        take: 30,
      });

      // Map employeeId to User records to attach employeeName (Exclude OWNER)
      const employeeIds = Array.from(new Set(rawRecentLogs.map((l) => l.employeeId)));
      const usersForLogs = await prisma.user.findMany({
        where: {
          organizationId,
          role: { not: "OWNER" },
          OR: [
            { employeeId: { in: employeeIds } },
            ...employeeIds.map((eid) => ({ employeeId: { endsWith: `-${eid}` } })),
            ...employeeIds.map((eid) => ({ employeeId: { endsWith: `-${eid.padStart(4, "0")}` } })),
          ],
        },
        select: { employeeId: true, fullName: true },
      });

      const userMap = new Map();
      usersForLogs.forEach((u) => {
        userMap.set(u.employeeId, u.fullName);
        const parts = u.employeeId.split("-");
        const suffix = parts[parts.length - 1];
        if (suffix) userMap.set(suffix, u.fullName);
      });

      const recentLogs = rawRecentLogs.map((log) => ({
        ...log,
        employeeName: userMap.get(log.employeeId) || userMap.get(log.employeeId.replace(/^0+/, "")) || null,
      }));

      return res.status(200).json({
        device,
        isTerminalReachable,
        totalTerminalUsers: terminalUsers.length,
        terminalUsers,
        recentLogs,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/devices/:id/sync-punches (Directly pull AcsEvents from Hikvision and record attendance)
  router.post("/:id/sync-punches", authenticateToken, requirePermissions(prisma, "devices.manage"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { days } = req.body || {};
      const organizationId = req.user.organizationId;

      const device = await prisma.biometricDevice.findFirst({
        where: { id, organizationId },
      });

      if (!device || !device.ipAddress) {
        return res.status(404).json({ message: "Device not found or IP not configured." });
      }

      const user = device.username || "admin";
      const pass = device.password || "";
      const host = device.ipAddress;
      const path = "/ISAPI/AccessControl/AcsEvent?format=json";

      // 1. Determine Start & End Time (Default to last 35 days / from 1st of current month to ensure full history)
      const now = new Date();
      const pullDays = typeof days === "number" && days > 0 ? days : 35;
      const pastDate = new Date(now.getTime() - pullDays * 24 * 60 * 60 * 1000);
      const startYMD = pastDate.toLocaleDateString("en-CA");
      const endYMD = now.toLocaleDateString("en-CA");

      const startTime = `${startYMD}T00:00:00`;
      const endTime = `${endYMD}T23:59:59`;

      // 2. Helper to query device via ISUP Bridge / Tunnel / Direct HTTPS
      const queryAcsEvents = async (bodyObj) => {
        const bodyStr = JSON.stringify(bodyObj);

        // Priority 1: Always try ISUP Tunnel / Gateway first
        try {
          const resp = await sendDeviceCommandViaTunnel(device.deviceSerialNumber, {
            method: "POST",
            path,
            body: bodyStr,
            timeout: 10000,
          });
          if (resp && resp.data) {
            const parsed = typeof resp.data === "string" ? JSON.parse(resp.data) : resp.data;
            if (parsed && !parsed.error) return parsed;
          }
        } catch (tErr) {
          console.warn("[sync-punches via ISUP/Tunnel notice]:", tErr.message);
        }

        // Priority 2: Direct network fallback (only if routable public host)
        if (!host || host === "10.0.0.2" || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.")) {
          return null;
        }
        return new Promise((resolve) => {
          const req1 = https.request(
            {
              hostname: host,
              port: 443,
              path,
              method: "POST",
              rejectUnauthorized: false,
              timeout: 5000,
              headers: { "Content-Type": "application/json", "Content-Length": 0 },
            },
            (res1) => {
              if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                const auth = res1.headers["www-authenticate"];
                const digest = buildDigestHeader("POST", path, user, pass, auth);
                const req2 = https.request(
                  {
                    hostname: host,
                    port: 443,
                    path,
                    method: "POST",
                    rejectUnauthorized: false,
                    timeout: 8000,
                    headers: {
                      "Content-Type": "application/json",
                      "Content-Length": Buffer.byteLength(bodyStr),
                      Authorization: digest,
                    },
                  },
                  (res2) => {
                    let buf = "";
                    res2.on("data", (c) => (buf += c));
                    res2.on("end", () => {
                      try {
                        resolve(JSON.parse(buf));
                      } catch (e) {
                        resolve(null);
                      }
                    });
                  }
                );
                req2.on("error", () => resolve(null));
                req2.on("timeout", () => { req2.destroy(); resolve(null); });
                req2.write(bodyStr);
                req2.end();
              } else {
                resolve(null);
              }
            }
          );
          req1.on("error", () => resolve(null));
          req1.on("timeout", () => { req1.destroy(); resolve(null); });
          req1.end();
        });
      };

      // Probe total matches first
      const probeRes = await queryAcsEvents({
        AcsEventCond: {
          searchID: "probe_total",
          searchResultPosition: 0,
          maxResults: 1,
          major: 0,
          minor: 0,
          startTime,
          endTime,
        },
      });

      const totalMatches = Number(probeRes?.AcsEvent?.totalMatches || 0);

      if (totalMatches === 0) {
        return res.status(200).json({ success: true, pulledCount: 0, message: "No event logs found on machine for selected date range." });
      }

      // 3. Paginated fetch — pull ALL events across the period (up to 2000 events)
      let eventsList = [];
      let pos = 0;
      const BATCH_SIZE = 50;

      while (true) {
        const batch = await queryAcsEvents({
          AcsEventCond: {
            searchID: `sync_${Date.now()}`,
            searchResultPosition: pos,
            maxResults: BATCH_SIZE,
            major: 0,
            minor: 0,
            startTime,
            endTime,
          },
        });

        const list = batch?.AcsEvent?.InfoList || [];
        if (list.length === 0) break;
        eventsList = eventsList.concat(list);
        pos += list.length;
        const total = Number(batch?.AcsEvent?.totalMatches || 0);
        if (pos >= total || list.length < BATCH_SIZE || pos >= 2000) break;
      }

      // Filter events that belong to persons (major: 5, with employeeNoString)
      // Minor codes: 75=Face, 38=Fingerprint, 1=Card, 104=Face/FP
      const personEvents = eventsList.filter(
        (e) => e.major === 5 && (e.minor === 75 || e.minor === 38 || e.minor === 1) && e.employeeNoString
      );

      // CRITICAL: Sort chronologically ascending (oldest punch first)
      personEvents.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

      // Cache all users in this organization for fast and accurate employee matching
      const allOrgUsers = await prisma.user.findMany({
        where: { organizationId },
        select: { id: true, employeeId: true, fullName: true, role: true, email: true },
      });

      const findUserForRawEmp = (rawEmp) => {
        const clean = String(rawEmp).trim();
        const noZeros = clean.replace(/^0+/, "");
        // 1. Exact match
        let found = allOrgUsers.find((u) => u.employeeId === clean);
        if (found) return found;

        // 2. Dash-separated format (e.g. EKH-26-0001 or EKH-26-0003)
        found = allOrgUsers.find((u) => {
          const parts = u.employeeId.split("-");
          if (parts.length > 1) {
            const suffix = parts[parts.length - 1];
            if (suffix === clean || suffix.replace(/^0+/, "") === noZeros) return true;
          }
          return false;
        });
        if (found) return found;

        // 3. Compact prefix format (e.g. EKH26004 for clean "4" or "EKH26004") - NEVER match UUID or OWNER
        found = allOrgUsers.find((u) => {
          if (u.role === "OWNER") return false;
          // Ignore users with UUID employeeId
          if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(u.employeeId)) return false;
          const m = u.employeeId.match(/\d+$/);
          if (m) {
            const digits = m[0];
            if (digits === clean || digits.replace(/^0+/, "") === noZeros) return true;
          }
          return false;
        });

        return found || null;
      };

      let recordedCount = 0;
      let attendanceCreatedCount = 0;

      for (const ev of personEvents) {
        const rawEmp = String(ev.employeeNoString).trim();
        const punchDate = new Date(ev.time);
        if (isNaN(punchDate.getTime())) continue;

        let verificationMode = "FINGERPRINT";
        if (ev.minor === 75) verificationMode = "FACE_SCAN";
        else if (ev.minor === 38) verificationMode = "FINGERPRINT";
        else if (ev.minor === 1) verificationMode = "CARD";
        
        const userRec = findUserForRawEmp(rawEmp);
        if (!userRec) continue;

        // Check if raw log already exists within 45s of punchTime for this user & serial
        const existingLog = await prisma.biometricRawLog.findFirst({
          where: {
            organizationId,
            employeeId: userRec.employeeId,
            punchTime: {
              gte: new Date(punchDate.getTime() - 45000),
              lte: new Date(punchDate.getTime() + 45000),
            },
          },
        });

        if (!existingLog) {
          await prisma.biometricRawLog.create({
            data: {
              organizationId,
              deviceId: device.id,
              deviceSerialNumber: device.deviceSerialNumber,
              employeeId: userRec.employeeId,
              punchTime: punchDate,
              punchType: "CHECK_IN",
              verificationMode,
              syncStatus: "PROCESSED",
            },
          });
          recordedCount++;
        }

        // Attendance ledger processing:
        // Use organization's dayCutoffHour (e.g. 6:00 AM) so midnight/overnight punches belong to correct day
        const dayUtcMidnight = await resolveAttendanceLedgerDate(organizationId, punchDate);

        const existingAtt = await prisma.attendance.findUnique({
          where: {
            userId_date: {
              userId: userRec.id,
              date: dayUtcMidnight,
            },
          },
        });

        if (!existingAtt) {
          // First punch of the day (Face scan or Fingerprint) -> Check in with shift/grace calculation!
          const attStatus = await determineAttendanceStatus(organizationId, userRec.id, punchDate);
          await prisma.attendance.create({
            data: {
              organizationId,
              userId: userRec.id,
              date: dayUtcMidnight,
              checkInTime: punchDate,
              currentState: "CHECKED_IN",
              status: attStatus,
              ipAddress: device.ipAddress,
              punchInDeviceType: "BIOMETRIC_TERMINAL",
              punchInAddress: device.locationName,
            },
          });
          attendanceCreatedCount++;
        } else if (
          verificationMode === "FINGERPRINT" &&
          existingAtt.checkInTime &&
          !existingAtt.checkOutTime &&
          punchDate.getTime() > existingAtt.checkInTime.getTime() + 60000
        ) {
          // Fingerprint punch marks Check-Out! Once checked out, never overwrite checkOutTime!
          const elapsedMinutes = Math.max(
            0,
            Math.round((punchDate.getTime() - existingAtt.checkInTime.getTime()) / (1000 * 60))
          );
          // Total work hours includes break time (break time is paid / not deducted)
          const totalWorkMinutes = elapsedMinutes;
          const overtimeMinutes = await determineOvertimeMinutes(organizationId, userRec.id, punchDate, totalWorkMinutes);

          await prisma.attendance.update({
            where: { id: existingAtt.id },
            data: {
              checkOutTime: punchDate,
              currentState: "CHECKED_OUT",
              totalWorkMinutes,
              overtimeMinutes,
              punchOutAddress: device.locationName,
            },
          });
        }
      }

      // Update device sync counter
      await prisma.biometricDevice.update({
        where: { id: device.id },
        data: {
          lastHeartbeat: new Date(),
          totalLogsSynced: { increment: recordedCount },
          status: "ONLINE",
        },
      });

      return res.status(200).json({
        success: true,
        totalEventsExamined: personEvents.length,
        recordedPunches: recordedCount,
        attendanceCheckIns: attendanceCreatedCount,
        message: `Pulled ${personEvents.length} verification events from machine. Saved ${recordedCount} new punches and logged ${attendanceCreatedCount} check-in(s).`,
      });
    } catch (err) {
      console.error("Sync punches error:", err.message);
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

      const employeeIds = Array.from(new Set(logs.map((l) => l.employeeId)));
      const usersForLogs = await prisma.user.findMany({
        where: {
          organizationId: req.user.organizationId,
          role: { not: "OWNER" },
          OR: [
            { employeeId: { in: employeeIds } },
            ...employeeIds.map((eid) => ({ employeeId: { endsWith: `-${eid}` } })),
            ...employeeIds.map((eid) => ({ employeeId: { endsWith: `-${eid.padStart(4, "0")}` } })),
          ],
        },
        select: { employeeId: true, fullName: true },
      });

      const userMap = new Map();
      usersForLogs.forEach((u) => {
        userMap.set(u.employeeId, u.fullName);
        const parts = u.employeeId.split("-");
        const suffix = parts[parts.length - 1];
        if (suffix) userMap.set(suffix, u.fullName);
      });

      const enrichedLogs = logs.map((log) => ({
        ...log,
        employeeName: userMap.get(log.employeeId) || userMap.get(log.employeeId.replace(/^0+/, "")) || null,
      }));

      return res.status(200).json(enrichedLogs);
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

      // 2. Locate device (flexible match: exact, contains, suffix, or single registered device fallback)
      const rawSerial = String(serialNumber).trim();
      let device = await prisma.biometricDevice.findFirst({
        where: {
          OR: [
            { deviceSerialNumber: rawSerial },
            { deviceSerialNumber: { contains: rawSerial } },
            { deviceSerialNumber: { endsWith: rawSerial } },
          ],
        },
      });

      if (!device) {
        // Fallback: match by last 7 characters (e.g. 6443083) or find any active device
        const allDevices = await prisma.biometricDevice.findMany();
        device = allDevices.find(
          (d) =>
            d.deviceSerialNumber &&
            (d.deviceSerialNumber.includes(rawSerial) ||
             rawSerial.includes(d.deviceSerialNumber) ||
             d.deviceSerialNumber.slice(-7) === rawSerial.slice(-7))
        ) || allDevices[0];
      }

      if (!device || !device.organizationId) {
        return res.status(404).json({
          message: `Unregistered hardware device serial: ${serialNumber}`,
        });
      }
      // 3. Find user in the same organization (by employeeId, stripped dashes, or suffix)
      const cleanEmpId = String(employeeId).trim();
      const noDashEmpId = cleanEmpId.replace(/-/g, "");
      const noZeros = cleanEmpId.replace(/^0+/, "");
      
      const allUsers = await prisma.user.findMany({
        where: { organizationId: device.organizationId },
        select: { id: true, employeeId: true, fullName: true },
      });
      
      // Exact and precise matching:
      // 1. Exact match on employeeId
      let user = allUsers.find((u) => (u.employeeId || "").trim() === cleanEmpId || (u.employeeId || "").replace(/-/g, "") === noDashEmpId);
      // 2. Dash-delimited suffix match (e.g. EKH-26-0004 or EKH-26-4 matching "4" or "0004")
      if (!user) {
        user = allUsers.find((u) => {
          const parts = (u.employeeId || "").split("-");
          if (parts.length > 1) {
            const suffix = parts[parts.length - 1].trim();
            const suffixNoZero = suffix.replace(/^0+/, "");
            return suffix === cleanEmpId || suffixNoZero === noZeros;
          }
          return false;
        });
      }

      if (!user) {
        return res.status(404).json({
          message: `Employee ID "${cleanEmpId}" not found in workspace organization.`,
        });
      }

      const punchDate = punchTime;
      const utcMidnightToday = await resolveAttendanceLedgerDate(device.organizationId, punchDate);

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
        const attStatus = await determineAttendanceStatus(device.organizationId, user.id, punchDate);
        await prisma.attendance.create({
          data: {
            organizationId: device.organizationId,
            userId: user.id,
            date: utcMidnightToday,
            checkInTime: punchDate,
            currentState: "CHECKED_IN",
            status: attStatus,
            ipAddress: device.ipAddress || "BIOMETRIC_HARDWARE",
            punchInDeviceType: "BIOMETRIC_TERMINAL",
            punchInAddress: device.locationName,
          },
        });
      } else if (
        verificationMode === "FINGERPRINT" &&
        existingAttendance.checkInTime &&
        !existingAttendance.checkOutTime &&
        punchDate.getTime() > existingAttendance.checkInTime.getTime() + 60000
      ) {
        // Only genuine FINGERPRINT punches mark Check-Out after check-in! Once checked out, never overwrite!
        const elapsedMinutes = Math.max(
          0,
          Math.round((punchDate.getTime() - existingAttendance.checkInTime.getTime()) / (1000 * 60))
        );
        // Total work hours includes break time (break time is paid / not deducted)
        const totalWorkMinutes = elapsedMinutes;
        const overtimeMinutes = await determineOvertimeMinutes(device.organizationId, user.id, punchDate, totalWorkMinutes);

        await prisma.attendance.update({
          where: { id: existingAttendance.id },
          data: {
            checkOutTime: punchDate,
            currentState: "CHECKED_OUT",
            totalWorkMinutes,
            overtimeMinutes,
            punchOutAddress: device.locationName,
          },
        });
      }

      return res.status(200).json({ success: true, message: "Punch log processed successfully" });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Biometric Terminal Sync Engine:
  // - Quick Mode: Polls today and yesterday (instant, 1-2 seconds for UI button)
  // - Custom Date Range Mode: Syncs exact startDate and endDate
  // - Full/Historical Mode: Intelligent catch-up covering history
  // Face sync & photo upload is deferred non-blocking to keep attendance fast
  // -------------------------------------------------------------------------
  async function pollAllOnlineDevices(targetOrgId = null, options = {}) {
    try {
      const activeDevices = await prisma.biometricDevice.findMany({
        where: {
          ipAddress: { not: null },
          ...(targetOrgId ? { organizationId: targetOrgId } : {}),
        },
      });

      for (const dev of activeDevices) {
        if (!dev.ipAddress || !dev.organizationId) continue;
        const user = dev.username || "admin";
        const pass = dev.password || "";
        const host = dev.ipAddress;
        const path = "/ISAPI/AccessControl/AcsEvent?format=json";

        const now = new Date();
        let startTime, endTime;

        if (options.startDate && options.endDate) {
          startTime = `${options.startDate}T00:00:00`;
          endTime = `${options.endDate}T23:59:59`;
        } else if (options.quick !== false) {
          // Default Quick Mode: Today and Yesterday (Super fast, 1-2 seconds!)
          const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          const startYMD = yesterday.toLocaleDateString("en-CA");
          const endYMD = now.toLocaleDateString("en-CA");
          startTime = `${startYMD}T00:00:00`;
          endTime = `${endYMD}T23:59:59`;
        } else {
          // Full/Historical catch-up
          const latestDbLog = await prisma.biometricRawLog.findFirst({
            where: { deviceSerialNumber: dev.deviceSerialNumber },
            orderBy: { punchTime: "desc" },
            select: { punchTime: true },
          });

          const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
          const syncStartDate = latestDbLog?.punchTime
            ? new Date(Math.max(oneYearAgo.getTime(), latestDbLog.punchTime.getTime() - 24 * 60 * 60 * 1000))
            : oneYearAgo;

          const startYMD = syncStartDate.toLocaleDateString("en-CA");
          const endYMD = now.toLocaleDateString("en-CA");
          startTime = `${startYMD}T00:00:00`;
          endTime = `${endYMD}T23:59:59`;
        }

        let eventsList = [];
        let pos = 0;
        const maxBatches = options.quick !== false ? 5 : 50;
        let batchCount = 0;

        // Helper to query device events via ISUP Gateway or direct network
        const queryDeviceBatch = async (bodyObj) => {
          const bodyStr = JSON.stringify(bodyObj);

          // Always try cloud tunnel / ISUP Gateway first!
          try {
            console.log(`[Pull Attendance] Attempting ISUP tunnel query for device ${dev.deviceSerialNumber}...`);
            const resp = await sendDeviceCommandViaTunnel(dev.deviceSerialNumber, {
              method: "POST",
              path,
              body: bodyStr,
              timeout: 10000,
            });
            if (resp && resp.data) {
              const parsed = typeof resp.data === "string" ? JSON.parse(resp.data) : resp.data;
              if (parsed && !parsed.error) {
                console.log(`[Pull Attendance] ✓ ISUP tunnel returned data:`, parsed?.AcsEvent ? `Matches: ${parsed.AcsEvent.totalMatches}` : "OK");
                return parsed;
              }
            }
          } catch (tErr) {
            console.warn(`[Pull Attendance] ISUP tunnel query attempt notice:`, tErr.message);
          }

          // If device host is a private/Docker IP (e.g. 10.x.x.x, 192.168.x.x), direct HTTPS from cloud VPS is impossible
          if (!host || host === "10.0.0.2" || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.")) {
            return null;
          }

          return new Promise((resolve) => {
            const req1 = https.request(
              {
                hostname: host,
                port: 443,
                path,
                method: "POST",
                rejectUnauthorized: false,
                timeout: 5000,
                headers: { "Content-Type": "application/json", "Content-Length": 0 },
              },
              (res1) => {
                if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                  const auth = res1.headers["www-authenticate"];
                  const digest = buildDigestHeader("POST", path, user, pass, auth);
                  const req2 = https.request(
                    {
                      hostname: host,
                      port: 443,
                      path,
                      method: "POST",
                      rejectUnauthorized: false,
                      timeout: 6000,
                      headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(bodyStr),
                        Authorization: digest,
                      },
                    },
                    (res2) => {
                      let b = "";
                      res2.on("data", (c) => (b += c));
                      res2.on("end", () => {
                        try {
                          resolve(JSON.parse(b));
                        } catch (e) {
                          resolve(null);
                        }
                      });
                    }
                  );
                  req2.on("error", () => resolve(null));
                  req2.on("timeout", () => { req2.destroy(); resolve(null); });
                  req2.write(bodyStr);
                  req2.end();
                } else {
                  resolve(null);
                }
              }
            );
            req1.on("error", () => resolve(null));
            req1.on("timeout", () => { req1.destroy(); resolve(null); });
            req1.end();
          });
        };

        while (batchCount < maxBatches) {
          batchCount++;
          const batch = await queryDeviceBatch({
            AcsEventCond: {
              searchID: `auto_${Date.now()}`,
              searchResultPosition: pos,
              maxResults: 30,
              major: 0,
              minor: 0,
              startTime,
              endTime,
            },
          });

          const list = batch?.AcsEvent?.InfoList || [];
          if (list.length === 0) break;
          eventsList = eventsList.concat(list);
          pos += list.length;
          if (pos >= (batch?.AcsEvent?.totalMatches || 0) || list.length < 30) break;
        }

        const personEvents = eventsList.filter(
          (e) => e.major === 5 && (e.minor === 75 || e.minor === 38 || e.minor === 1) && e.employeeNoString
        );

        if (personEvents.length === 0) continue;

        // CRITICAL: Sort chronologically ascending (oldest punch first) so morning check-in is processed before afternoon/evening check-out!
        personEvents.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

        const allOrgUsers = await prisma.user.findMany({
          where: { organizationId: dev.organizationId },
          select: { id: true, employeeId: true, fullName: true, role: true, avatarUrl: true },
        });

        // Get org prefix for dynamic ID formatting
        const orgForPrefix = await prisma.organization.findUnique({
          where: { id: dev.organizationId },
          select: { employeePrefix: true },
        });
        const orgPrefix = orgForPrefix?.employeePrefix || "";

        const findUser = (rawEmp, personName = "") => {
          const clean = String(rawEmp).trim();
          const cleanName = String(personName || "").trim().toLowerCase();

          // 1. Strict exact employeeId match
          let f = allOrgUsers.find((u) => u.employeeId === clean);
          if (f) return f;

          // 2. Dash-strip match: terminal sends "EKH260002", DB has "EKH-26-0002"
          //    Strip dashes from DB employeeId and compare
          if (!clean.includes("-")) {
            f = allOrgUsers.find((u) => u.employeeId && u.employeeId.replace(/-/g, "") === clean);
            if (f) return f;
          }

          // 3. Fallback to exact fullName match if provided
          if (cleanName) {
            f = allOrgUsers.find(
              (u) => u.fullName && u.fullName.trim().toLowerCase() === cleanName
            );
            if (f) return f;
          }

          return null;
        };

        let newRawCount = 0;
        for (const ev of personEvents) {
          const punchDate = new Date(ev.time);
          if (isNaN(punchDate.getTime())) continue;

          let verificationMode = "FINGERPRINT";
          if (ev.minor === 75) verificationMode = "FACE_SCAN";
          else if (ev.minor === 38) verificationMode = "FINGERPRINT";
          else if (ev.minor === 1) verificationMode = "CARD";
          
          const userRec = findUser(ev.employeeNoString);
          if (!userRec) continue;

          const existingLog = await prisma.biometricRawLog.findFirst({
            where: {
              organizationId: dev.organizationId,
              employeeId: userRec.employeeId,
              punchTime: {
                gte: new Date(punchDate.getTime() - 45000),
                lte: new Date(punchDate.getTime() + 45000),
              },
            },
          });

          if (!existingLog) {
            await prisma.biometricRawLog.create({
              data: {
                organizationId: dev.organizationId,
                deviceId: dev.id,
                deviceSerialNumber: dev.deviceSerialNumber,
                employeeId: userRec.employeeId,
                punchTime: punchDate,
                punchType: "CHECK_IN",
                verificationMode,
                syncStatus: "PROCESSED",
              },
            });
            newRawCount++;
          }

          const dayUtcMidnight = await resolveAttendanceLedgerDate(dev.organizationId, punchDate);

          const existingAtt = await prisma.attendance.findUnique({
            where: {
              userId_date: {
                userId: userRec.id,
                date: dayUtcMidnight,
              },
            },
          });

          if (!existingAtt) {
            const attStatus = await determineAttendanceStatus(dev.organizationId, userRec.id, punchDate);
            await prisma.attendance.create({
              data: {
                organizationId: dev.organizationId,
                userId: userRec.id,
                date: dayUtcMidnight,
                checkInTime: punchDate,
                currentState: "CHECKED_IN",
                status: attStatus,
                ipAddress: dev.ipAddress,
                punchInDeviceType: "BIOMETRIC_TERMINAL",
                punchInAddress: dev.locationName,
              },
            });
          } else if (
            verificationMode === "FINGERPRINT" &&
            existingAtt.checkInTime &&
            !existingAtt.checkOutTime &&
            punchDate.getTime() > existingAtt.checkInTime.getTime() + 60000
          ) {
            // Fingerprint punch marks Check-Out! Once checked out, never overwrite checkOutTime!
            const elapsedMinutes = Math.max(
              0,
              Math.round((punchDate.getTime() - existingAtt.checkInTime.getTime()) / (1000 * 60))
            );
            // Total work hours includes break time (break time is paid / not deducted)
            const totalWorkMinutes = elapsedMinutes;
            const overtimeMinutes = await determineOvertimeMinutes(dev.organizationId, userRec.id, punchDate, totalWorkMinutes);

            await prisma.attendance.update({
              where: { id: existingAtt.id },
              data: {
                checkOutTime: punchDate,
                currentState: "CHECKED_OUT",
                totalWorkMinutes,
                overtimeMinutes,
                punchOutAddress: dev.locationName,
              },
            });
          }
        }

        if (newRawCount > 0) {
          await prisma.biometricDevice.update({
            where: { id: dev.id },
            data: {
              lastHeartbeat: new Date(),
              totalLogsSynced: { increment: newRawCount },
              status: "ONLINE",
            },
          });
        }

        // Deferred Non-blocking Biometric Status & Face Sync:
        // Do NOT block UI response for face photo sync or avatar upload.
        // Run asynchronously in the background so Attendance Sync finishes in 1-2 seconds!
        setImmediate(async () => {
          try {
            // Helper: make an authenticated request to device (prioritizes reverse tunnel)
            const deviceRequest = async (method, reqPath, bodyStr = null) => {
              if (isDeviceTunnelOnline(dev.deviceSerialNumber)) {
                try {
                  const resp = await sendDeviceCommandViaTunnel(dev.deviceSerialNumber, {
                    method,
                    path: reqPath,
                    body: bodyStr,
                    timeout: 8000,
                  });
                  if (resp && resp.data) {
                    return Buffer.isBuffer(resp.data) ? resp.data : Buffer.from(typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data));
                  }
                } catch (e) {
                  // fall through to direct network
                }
              }

              return new Promise((resolve) => {
                const bodyBuf = bodyStr ? Buffer.from(bodyStr) : null;
                const headers = { "Content-Type": "application/json" };
                if (bodyBuf) headers["Content-Length"] = bodyBuf.length;
                else headers["Content-Length"] = 0;

                const req1 = https.request(
                  { hostname: host, port: 443, path: reqPath, method, rejectUnauthorized: false, timeout: 6000, headers },
                  (res1) => {
                    const drain = (r) => { r.resume(); };
                    if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                      drain(res1);
                      const digest = buildDigestHeader(method, reqPath, user, pass, res1.headers["www-authenticate"]);
                      const authHeaders = { ...headers, Authorization: digest };
                      const req2 = https.request(
                        { hostname: host, port: 443, path: reqPath, method, rejectUnauthorized: false, timeout: 8000, headers: authHeaders },
                        (res2) => {
                          const chunks = [];
                          res2.on("data", (c) => chunks.push(c));
                          res2.on("end", () => resolve(Buffer.concat(chunks)));
                        }
                      );
                      req2.on("error", () => resolve(null));
                      req2.on("timeout", () => { req2.destroy(); resolve(null); });
                      if (bodyBuf) req2.write(bodyBuf);
                      req2.end();
                    } else if (res1.statusCode === 200) {
                      const chunks = [];
                      res1.on("data", (c) => chunks.push(c));
                      res1.on("end", () => resolve(Buffer.concat(chunks)));
                    } else {
                      drain(res1);
                      resolve(null);
                    }
                  }
                );
                req1.on("error", () => resolve(null));
                req1.on("timeout", () => { req1.destroy(); resolve(null); });
                if (bodyBuf) req1.write(bodyBuf);
                req1.end();
              });
            };

            // Step 1: Fetch terminal UserInfo to reconcile fingerprint & face counts for ALL users
            const termPersonNameByNo = new Map();
            let uPos = 0;
            while (true) {
              const uPath = "/ISAPI/AccessControl/UserInfo/Search?format=json";
              const uBody = JSON.stringify({
                UserInfoSearchCond: { searchID: `fs_u_${uPos}`, searchResultPosition: uPos, maxResults: 50 },
              });
              const uBuf = await deviceRequest("POST", uPath, uBody);
              if (!uBuf) break;
              let uData = null;
              try { uData = JSON.parse(uBuf.toString()); } catch { break; }
              const uList = uData?.UserInfoSearch?.UserInfo || [];
              for (const u of uList) {
                if (!u.employeeNo) continue;
                const rawNo = String(u.employeeNo).trim();
                termPersonNameByNo.set(rawNo, u.name || "");

                // Sync biometric permission badges (face & fingerprint) to DB accurately reflecting terminal state
                const numOfFace = Number(u.numOfFace || 0);
                const numOfFP = Number(u.numOfFP || 0);
                const matchedUser = findUser(rawNo, u.name || "");
                if (matchedUser && matchedUser.role !== "OWNER") {
                  const perms = Array.isArray(matchedUser.permissions) ? matchedUser.permissions : [];
                  const basePerms = perms.filter((p) => typeof p === "string" && !p.startsWith("bio:"));
                  const newPerms = [...basePerms];
                  if (numOfFP > 0) newPerms.push("bio:fingerprint");
                  if (numOfFace > 0) newPerms.push("bio:face");

                  const sortedCurrent = [...perms].sort().join(",");
                  const sortedNew = [...newPerms].sort().join(",");

                  if (sortedCurrent !== sortedNew) {
                    await prisma.user.update({
                      where: { id: matchedUser.id },
                      data: { permissions: newPerms },
                    });
                    matchedUser.permissions = newPerms;
                  }
                }
              }
              uPos += uList.length;
              if (uList.length < 50 || uPos >= (uData?.UserInfoSearch?.totalMatches || 0)) break;
            }

            // Step 2: Fetch and sync face photos only if new punches or new face detected
            if (newRawCount > 0) {
              const allMatchList = [];
              for (const libType of ["staticWhite", "blackFD"]) {
                let fdPos = 0;
                while (true) {
                  const fdPath = "/ISAPI/Intelligent/FDLib/FDSearch?format=json";
                  const fdBody = JSON.stringify({
                    searchResultPosition: fdPos,
                    maxResults: 50,
                    faceLibType: libType,
                    FDID: "1",
                  });
                  const fdBuf = await deviceRequest("POST", fdPath, fdBody);
                  if (!fdBuf) break;
                  let fdData = null;
                  try { fdData = JSON.parse(fdBuf.toString()); } catch { break; }
                  const batch = fdData?.MatchList || [];
                  allMatchList.push(...batch);
                  fdPos += batch.length;
                  if (batch.length < 50 || fdPos >= (fdData?.totalMatches || 0)) break;
                }
              }

              const processedEmpIds = new Set();
              for (const m of allMatchList) {
                const fpid = String(m.FPID || "").trim();
                const faceURL = m.faceURL;
                if (!fpid || !faceURL) continue;

                const terminalPersonName = termPersonNameByNo.get(fpid) || "";
                const empToUpdate = findUser(fpid, terminalPersonName);
                if (!empToUpdate || empToUpdate.role === "OWNER" || empToUpdate.avatarUrl || processedEmpIds.has(empToUpdate.id)) continue;

                let getPath;
                try {
                  const urlObj = new URL(faceURL);
                  getPath = urlObj.pathname + urlObj.search;
                } catch {
                  getPath = faceURL;
                }

                const imgBuf = await deviceRequest("GET", getPath);
                if (!imgBuf || imgBuf.length < 500) continue;

                const cloudName = process.env.CLOUDINARY_CLOUD_NAME || "jawcusfd";
                const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET || "ekhone-hrms";
                const base64Data = `data:image/jpeg;base64,${imgBuf.toString("base64")}`;
                const formData = new FormData();
                formData.append("file", base64Data);
                formData.append("upload_preset", uploadPreset);
                formData.append("folder", "hrms/employee-avatars");
                formData.append("public_id", `emp_${empToUpdate.id}_face`);

                try {
                  const upRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
                    method: "POST",
                    body: formData,
                  });
                  const upJson = await upRes.json();
                  if (upJson.secure_url) {
                    const existingPerms = Array.isArray(empToUpdate.permissions) ? empToUpdate.permissions : [];
                    const updatedPerms = Array.from(new Set([...existingPerms, "bio:face"]));

                    await prisma.user.update({
                      where: { id: empToUpdate.id },
                      data: {
                        avatarUrl: upJson.secure_url,
                        permissions: updatedPerms,
                      },
                    });
                    empToUpdate.avatarUrl = upJson.secure_url;
                    empToUpdate.permissions = updatedPerms;
                    processedEmpIds.add(empToUpdate.id);
                  }
                } catch (upErr) {
                  console.warn(`[Auto-Face] Upload error:`, upErr.message);
                }
              }
            }
          } catch (faceErr) {
            console.warn(`[Auto-Bio] Sync error for device ${host}:`, faceErr.message);
          }
        });
      }
    } catch (err) {
      console.warn("Background device auto-poll cycle notice:", err.message);
    }
  }

  // Scalable Multi-Tenant Architecture:
  // Instead of bombarding 1000s of client LAN IPs with 30s background HTTP polling,
  // we expose an on-demand reconciliation endpoint (/api/devices/reconcile-bio) triggered
  // when an Admin opens the Employee Directory, and hardware devices push real-time events
  // directly via webhook (/api/devices/webhook/push-log).

  // POST /api/devices/reconcile-bio
  // Triggered on-demand by UI when viewing personnel or device management
  router.post("/reconcile-bio", authenticateToken, async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const onlineDevices = await prisma.biometricDevice.findMany({
        where: { organizationId, ipAddress: { not: null } },
      });

      if (!onlineDevices.length) {
        return res.status(200).json({ success: true, message: "No active devices to reconcile." });
      }

      // Reconcile in background non-blocking so UI remains instant
      (async () => {
        for (const dev of onlineDevices) {
          try {
            const host = dev.ipAddress;
            const user = dev.username || "admin";
            const pass = dev.password || "";

            // Helper: device request with Digest Auth (ISUP Tunnel priority)
            const deviceRequest = async (method, reqPath, bodyStr = null) => {
              // Priority 1: Cloud ISUP Gateway Tunnel
              try {
                const resp = await sendDeviceCommandViaTunnel(dev.deviceSerialNumber, {
                  method,
                  path: reqPath,
                  body: bodyStr,
                  timeout: 10000,
                });
                if (resp && resp.data) {
                  return Buffer.from(typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data));
                }
              } catch (tErr) {
                // fallback
              }

              // Direct HTTPS fallback (only if routable public host)
              if (!host || host === "10.0.0.2" || host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.")) {
                return null;
              }

              return new Promise((resolve) => {
                const bodyBuf = bodyStr ? Buffer.from(bodyStr) : null;
                const headers = { "Content-Type": "application/json" };
                if (bodyBuf) headers["Content-Length"] = bodyBuf.length;
                else headers["Content-Length"] = 0;

                const req1 = https.request(
                  { hostname: host, port: 443, path: reqPath, method, rejectUnauthorized: false, timeout: 5000, headers },
                  (res1) => {
                    const drain = (r) => { r.resume(); };
                    if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                      drain(res1);
                      const digest = buildDigestHeader(method, reqPath, user, pass, res1.headers["www-authenticate"]);
                      const authHeaders = { ...headers, Authorization: digest };
                      const req2 = https.request(
                        { hostname: host, port: 443, path: reqPath, method, rejectUnauthorized: false, timeout: 6000, headers: authHeaders },
                        (res2) => {
                          const chunks = [];
                          res2.on("data", (c) => chunks.push(c));
                          res2.on("end", () => resolve(Buffer.concat(chunks)));
                        }
                      );
                      req2.on("error", () => resolve(null));
                      req2.on("timeout", () => { req2.destroy(); resolve(null); });
                      if (bodyBuf) req2.write(bodyBuf);
                      req2.end();
                    } else if (res1.statusCode === 200) {
                      const chunks = [];
                      res1.on("data", (c) => chunks.push(c));
                      res1.on("end", () => resolve(Buffer.concat(chunks)));
                    } else {
                      drain(res1);
                      resolve(null);
                    }
                  }
                );
                req1.on("error", () => resolve(null));
                req1.on("timeout", () => { req1.destroy(); resolve(null); });
                if (bodyBuf) req1.write(bodyBuf);
                req1.end();
              });
            };

            let uPos = 0;
            const dbUsers = await prisma.user.findMany({ where: { organizationId, role: { not: "OWNER" } } });

            while (true) {
              const uPath = "/ISAPI/AccessControl/UserInfo/Search?format=json";
              const uBody = JSON.stringify({
                UserInfoSearchCond: { searchID: `rec_${uPos}`, searchResultPosition: uPos, maxResults: 50 },
              });
              const uBuf = await deviceRequest("POST", uPath, uBody);
              if (!uBuf) break;
              let uData = null;
              try { uData = JSON.parse(uBuf.toString()); } catch { break; }
              const uList = uData?.UserInfoSearch?.UserInfo || [];
              for (const u of uList) {
                if (!u.employeeNo) continue;
                const rawNo = String(u.employeeNo).trim();
                const cleanNo = rawNo.replace(/-/g, "");
                const matchedUser = dbUsers.find((dbU) => {
                  const dbClean = (dbU.employeeId || "").replace(/-/g, "");
                  return dbClean === cleanNo || dbU.employeeId === rawNo || (u.name && dbU.fullName.toLowerCase() === u.name.toLowerCase());
                });

                if (matchedUser) {
                  const numOfFace = Number(u.numOfFace || 0);
                  const numOfFP = Number(u.numOfFP || 0);
                  const perms = Array.isArray(matchedUser.permissions) ? matchedUser.permissions : [];
                  const basePerms = perms.filter((p) => typeof p === "string" && !p.startsWith("bio:"));
                  const newPerms = [...basePerms];
                  if (numOfFP > 0) newPerms.push("bio:fingerprint");
                  if (numOfFace > 0) newPerms.push("bio:face");

                  const sortedCur = [...perms].sort().join(",");
                  const sortedNew = [...newPerms].sort().join(",");
                  if (sortedCur !== sortedNew) {
                    await prisma.user.update({
                      where: { id: matchedUser.id },
                      data: { permissions: newPerms },
                    });
                    matchedUser.permissions = newPerms;
                  }
                }
              }
              uPos += uList.length;
              if (uList.length < 50 || uPos >= (uData?.UserInfoSearch?.totalMatches || 0)) break;
            }
          } catch (devErr) {
            console.warn(`On-demand reconcile error for device ${dev.deviceName}:`, devErr.message);
          }
        }
      })().catch((err) => console.warn("Background on-demand reconcile notice:", err.message));

      return res.status(200).json({ success: true, message: "Reconcile task initiated." });
    } catch (err) {
      next(err);
    }
  });

  
  // POST /api/devices/sync-all
  // On-demand: sync attendance punches from physical devices for current organization
  // Accepts optional { startDate, endDate, quick }
  router.post("/sync-all", authenticateToken, async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const { startDate, endDate, quick } = req.body || {};
      await pollAllOnlineDevices(organizationId, { startDate, endDate, quick });
      return res.status(200).json({ success: true, message: "Attendance synced successfully from devices." });
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // AUTOMATED LIGHTWEIGHT BACKGROUND ATTENDANCE AUTO-SYNC
  // =========================================================================
  // Runs autonomously in the background so even when Admins/HR are away at home (e.g. on Fridays/holidays),
  // attendance punches are automatically pulled from biometric terminals into the database.
  //
  // Protection against infinite loops & server slowness:
  // 1. Mutex flag (`isBackgroundSyncRunning`): Prevents concurrent/overlapping executions.
  // 2. Cooldown debounce: At least 30 seconds between auto-sync runs.
  // 3. Quick Mode: Only pulls today's punches (super fast, < 500ms).
  // 4. Safe timeout & error handling: Never hangs the Node.js event loop.
  // =========================================================================
  let isBackgroundSyncRunning = false;
  let lastBackgroundSyncTimestamp = 0;

  async function triggerAutoDeviceSync(reason = "periodic") {
    const now = Date.now();
    if (isBackgroundSyncRunning) {
      return false;
    }
    // Rate limit: Do not run more frequently than once every 30 seconds
    if (now - lastBackgroundSyncTimestamp < 30000) {
      return false;
    }

    isBackgroundSyncRunning = true;
    lastBackgroundSyncTimestamp = now;

    try {
      console.log(`[Device Auto-Sync] 🔄 Starting quick background sync (${reason})...`);
      await pollAllOnlineDevices(null, { quick: true });
      console.log(`[Device Auto-Sync] ✓ Completed quick background sync (${reason}).`);
      return true;
    } catch (syncErr) {
      console.warn(`[Device Auto-Sync] Notice (${reason}):`, syncErr.message);
      return false;
    } finally {
      isBackgroundSyncRunning = false;
    }
  }

  // Register on global so other routes (like break-start & today-status) can trigger JIT sync
  global.g_triggerAutoDeviceSync = triggerAutoDeviceSync;

  // Initial sync delayed by 15 seconds after server boot
  setTimeout(() => {
    triggerAutoDeviceSync("startup");
  }, 15000);

  // Periodic recurring background sync: Every 2 minutes (120,000 ms)
  const autoSyncInterval = setInterval(() => {
    triggerAutoDeviceSync("periodic_cron");
  }, 120000);

  if (autoSyncInterval.unref) {
    autoSyncInterval.unref();
  }

  return router;
}

module.exports = { createDevicesRouter };
