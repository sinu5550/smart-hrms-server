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
  async function determineOvertimeMinutes(organizationId, userId, checkOutDate) {
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

      const endTimeStr = setting?.endTime || "18:00";
      const thresholdMins = typeof setting?.overtimeThresholdMins === "number" ? setting.overtimeThresholdMins : 30;
      const [endHour, endMinute] = endTimeStr.split(":").map(Number);

      // Convert checkOutDate to local hours/minutes (+06:00)
      const checkOut = new Date(checkOutDate);
      const checkOutMins = ((checkOut.getUTCHours() + 6) % 24) * 60 + checkOut.getUTCMinutes();
      const shiftEndMins = endHour * 60 + endMinute;

      // Overtime counts only if checkOutMins >= shiftEndMins + thresholdMins
      if (checkOutMins >= shiftEndMins + thresholdMins) {
        return checkOutMins - shiftEndMins;
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

      // Helper: Digest-auth POST to device, returns parsed JSON or null
      const devicePost = (reqPath, bodyObj) =>
        new Promise((resolve) => {
          const bodyStr = JSON.stringify(bodyObj);
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

      // Find target user from database
      const emp = await prisma.user.findFirst({
        where: {
          organizationId,
          OR: [
            ...(employeeDbId ? [{ id: employeeDbId }] : []),
            ...(employeeId ? [{ employeeId }, { id: employeeId }] : []),
          ],
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

      // Execute PUT with Digest Auth
      const pushResult = await new Promise((resolve, reject) => {
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

      // Send to Hikvision device via ISAPI PUT
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
      });

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
      });

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

          // 1. Fetch Users directly with 5s timeout
          const userPath = "/ISAPI/AccessControl/UserInfo/Search?format=json";
          const searchBody = JSON.stringify({
            UserInfoSearchCond: {
              searchID: "1",
              searchResultPosition: 0,
              maxResults: 100,
            },
          });

          const userData = await new Promise((resolve, reject) => {
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

      // 2. Probe total matches first
      const probeBody = JSON.stringify({
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

      const totalMatches = await new Promise((resolve, reject) => {
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
                    "Content-Length": Buffer.byteLength(probeBody),
                    Authorization: digest,
                  },
                },
                (res2) => {
                  let buf = "";
                  res2.on("data", (c) => (buf += c));
                  res2.on("end", () => {
                    try {
                      const parsed = JSON.parse(buf);
                      resolve(Number(parsed.AcsEvent?.totalMatches || 0));
                    } catch (e) {
                      resolve(0);
                    }
                  });
                }
              );
              req2.on("error", reject);
              req2.write(probeBody);
              req2.end();
            } else {
              resolve(0);
            }
          }
        );
        req1.on("error", reject);
        req1.end();
      });

      if (totalMatches === 0) {
        return res.status(200).json({ success: true, pulledCount: 0, message: "No event logs found on machine for selected date range." });
      }

      // 3. Paginated fetch — pull ALL events across the period (up to 2000 events)
      let eventsList = [];
      let pos = 0;
      const BATCH_SIZE = 50;

      while (true) {
        const fetchBody = JSON.stringify({
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

        const batch = await new Promise((resolve) => {
          const req1 = https.request(
            {
              hostname: host,
              port: 443,
              path,
              method: "POST",
              rejectUnauthorized: false,
              timeout: 6000,
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
                      "Content-Length": Buffer.byteLength(fetchBody),
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
                req2.write(fetchBody);
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
        (e) => e.major === 5 && (e.minor === 75 || e.minor === 38 || e.minor === 104 || e.minor === 1) && e.employeeNoString
      );

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
        else if (ev.minor === 104) verificationMode = "FACE_SCAN";

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
        // Normalize punchDate to UTC midnight of local day
        const localYMD = punchDate.toLocaleDateString("en-CA"); // YYYY-MM-DD format
        const [y, m, d] = localYMD.split("-").map(Number);
        const dayUtcMidnight = new Date(Date.UTC(y, m - 1, d));

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
        } else if (verificationMode === "FINGERPRINT" && existingAtt.checkInTime && punchDate.getTime() > existingAtt.checkInTime.getTime() + 60000) {
          // Fingerprint punch marks Check-Out!
          const elapsedMinutes = Math.max(
            0,
            Math.round((punchDate.getTime() - existingAtt.checkInTime.getTime()) / (1000 * 60))
          );
          const totalWorkMinutes = Math.max(0, elapsedMinutes - (existingAtt.totalBreakMinutes || 0));
          const overtimeMinutes = await determineOvertimeMinutes(organizationId, userRec.id, punchDate);

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
      } else if (existingAttendance.currentState !== "CHECKED_OUT") {
        const elapsedMinutes = Math.max(
          0,
          Math.round((punchDate.getTime() - existingAttendance.checkInTime.getTime()) / (1000 * 60))
        );
        const totalWorkMinutes = Math.max(
          0,
          elapsedMinutes - existingAttendance.totalBreakMinutes
        );
        const overtimeMinutes = await determineOvertimeMinutes(device.organizationId, user.id, punchDate);

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
  // Automatic Background Poller: Periodically sync punches every 30 seconds
  // Automatically detects when someone scans face or finger at the machine
  // -------------------------------------------------------------------------
  async function pollAllOnlineDevices() {
    try {
      const activeDevices = await prisma.biometricDevice.findMany({
        where: { ipAddress: { not: null } },
      });

      for (const dev of activeDevices) {
        if (!dev.ipAddress || !dev.organizationId) continue;
        const user = dev.username || "admin";
        const pass = dev.password || "";
        const host = dev.ipAddress;
        const path = "/ISAPI/AccessControl/AcsEvent?format=json";

        const probeBody = JSON.stringify({
          AcsEventCond: {
            searchID: "auto_1",
            searchResultPosition: 0,
            maxResults: 1,
            major: 0,
            minor: 0,
          },
        });

        const totalMatches = await new Promise((resolve) => {
          const req1 = https.request(
            {
              hostname: host,
              port: 443,
              path,
              method: "POST",
              rejectUnauthorized: false,
              timeout: 4000,
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
                    timeout: 4000,
                    headers: {
                      "Content-Type": "application/json",
                      "Content-Length": Buffer.byteLength(probeBody),
                      Authorization: digest,
                    },
                  },
                  (res2) => {
                    let b = "";
                    res2.on("data", (c) => (b += c));
                    res2.on("end", () => {
                      try {
                        const parsed = JSON.parse(b);
                        resolve(Number(parsed.AcsEvent?.totalMatches || 0));
                      } catch (e) {
                        resolve(0);
                      }
                    });
                  }
                );
                req2.on("error", () => resolve(0));
                req2.on("timeout", () => { req2.destroy(); resolve(0); });
                req2.write(probeBody);
                req2.end();
              } else {
                resolve(0);
              }
            }
          );
          req1.on("error", () => resolve(0));
          req1.on("timeout", () => { req1.destroy(); resolve(0); });
          req1.end();
        });

        // Fetch today's events from device with time range and pagination
        const localTodayYMD = new Date().toLocaleDateString("en-CA");
        const startTime = `${localTodayYMD}T00:00:00`;
        const endTime = `${localTodayYMD}T23:59:59`;

        let eventsList = [];
        let pos = 0;

        while (true) {
          const fetchBody = JSON.stringify({
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

          const batch = await new Promise((resolve) => {
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
                        "Content-Length": Buffer.byteLength(fetchBody),
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
                  req2.write(fetchBody);
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

          const list = batch?.AcsEvent?.InfoList || [];
          if (list.length === 0) break;
          eventsList = eventsList.concat(list);
          pos += list.length;
          if (pos >= (batch?.AcsEvent?.totalMatches || 0) || list.length < 30) break;
        }

        const personEvents = eventsList.filter(
          (e) => e.major === 5 && (e.minor === 75 || e.minor === 38 || e.minor === 104 || e.minor === 1) && e.employeeNoString
        );

        if (personEvents.length === 0) continue;

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
          else if (ev.minor === 104) verificationMode = "FACE_SCAN";

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

          const localYMD = punchDate.toLocaleDateString("en-CA");
          const [y, m, d] = localYMD.split("-").map(Number);
          const dayUtcMidnight = new Date(Date.UTC(y, m - 1, d));

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
          } else if (verificationMode === "FINGERPRINT" && existingAtt.checkInTime && punchDate.getTime() > existingAtt.checkInTime.getTime() + 60000) {
            // Fingerprint punch marks Check-Out!
            const elapsedMinutes = Math.max(
              0,
              Math.round((punchDate.getTime() - existingAtt.checkInTime.getTime()) / (1000 * 60))
            );
            const totalWorkMinutes = Math.max(0, elapsedMinutes - (existingAtt.totalBreakMinutes || 0));
            const overtimeMinutes = await determineOvertimeMinutes(dev.organizationId, userRec.id, punchDate);

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

        // Automatic Face Sync: Only check if new biometric punches were detected or if explicitly triggered
        // This avoids hammering device & Cloudinary API and saves server memory for SaaS scaling
        if (newRawCount > 0) {
          try {
          // Helper: make an authenticated HTTPS request to device with Digest Auth
          const deviceRequest = (method, reqPath, bodyStr = null) =>
            new Promise((resolve) => {
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
                    // Some devices skip 401 on first request if session is cached
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

          // Step 1: Fetch terminal UserInfo for name cross-check (paginated, up to 500 users)
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
                // Filter out previous bio tags and rebuild strictly from actual terminal enrollment counts
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

          // Step 2: Fetch all face records with pagination (try staticWhite first, then all types)
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

          console.log(`[Auto-Face] Device ${host}: found ${allMatchList.length} face records, ${termPersonNameByNo.size} terminal users`);

          // Step 3: Match each face to an employee and upload to Cloudinary
          // Deduplicate: track which employee IDs we already processed this cycle
          const processedEmpIds = new Set();

          for (const m of allMatchList) {
            const fpid = String(m.FPID || "").trim();
            const faceURL = m.faceURL;
            if (!fpid || !faceURL) continue;

            const terminalPersonName = termPersonNameByNo.get(fpid) || "";

            // Find matching employee by FPID (maps to employeeNo on device)
            const empToUpdate = findUser(fpid, terminalPersonName);
            if (!empToUpdate) {
              console.warn(`[Auto-Face] No DB match for FPID=${fpid} name="${terminalPersonName}"`);
              continue;
            }

            // Skip OWNER role
            if (empToUpdate.role === "OWNER") continue;

            // Skip if already has avatar
            if (empToUpdate.avatarUrl) continue;

            // Skip if already processed this employee in this cycle (prevent duplicate assignment)
            if (processedEmpIds.has(empToUpdate.id)) continue;

            // Safety: If both names exist and are completely different, do not assign
            if (terminalPersonName && empToUpdate.fullName) {
              const cleanTerm = terminalPersonName.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
              const cleanDb = empToUpdate.fullName.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
              if (cleanTerm && cleanDb && !cleanTerm.includes(cleanDb) && !cleanDb.includes(cleanTerm)) {
                console.warn(`[Auto-Face Safe Check] Skipped FPID=${fpid} ("${terminalPersonName}") -> no match DB "${empToUpdate.fullName}"`);
                continue;
              }
            }

            // Download face image from device
            let getPath;
            try {
              const urlObj = new URL(faceURL);
              getPath = urlObj.pathname + urlObj.search;
            } catch {
              // If faceURL is already a path
              getPath = faceURL;
            }

            const imgBuf = await deviceRequest("GET", getPath);
            if (!imgBuf || imgBuf.length < 500) {
              console.warn(`[Auto-Face] Image too small or missing for FPID=${fpid}`);
              continue;
            }

            // Upload to Cloudinary
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
                // Ensure bio:face is in user's permissions array so frontend renders face badge colored!
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
                console.log(`[Auto-Face] ✓ Synced face & bio badge for ${empToUpdate.fullName} (${empToUpdate.employeeId}) FPID=${fpid}`);
              } else {
                console.warn(`[Auto-Face] Cloudinary upload failed for ${empToUpdate.fullName}:`, upJson.error?.message);
              }
            } catch (upErr) {
              console.warn(`[Auto-Face] Upload error for ${empToUpdate.fullName}:`, upErr.message);
            }
          }
        } catch (faceErr) {
          console.warn(`[Auto-Face] Non-blocking sync error for device ${host}:`, faceErr.message);
        }
        }
      }
    } catch (err) {
      console.warn("Background device auto-poll cycle notice:", err.message);
    }
  }

  // Start the background poller interval (runs every 30 seconds)
  setInterval(pollAllOnlineDevices, 30000);
  // Run once on server startup after 5 seconds
  setTimeout(pollAllOnlineDevices, 5000);

  return router;
}

module.exports = { createDevicesRouter };
