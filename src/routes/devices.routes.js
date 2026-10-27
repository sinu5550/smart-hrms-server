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
        select: { employeePrefix: true },
      });
      const prefix = (org?.employeePrefix || "EKH").trim().toUpperCase();

      const user = device.username || "admin";
      const pass = device.password || "";
      const host = device.ipAddress;
      const path = "/ISAPI/AccessControl/UserInfo/Search?format=json";

      const searchBody = JSON.stringify({
        UserInfoSearchCond: {
          searchID: "1",
          searchResultPosition: 0,
          maxResults: 100,
        },
      });

      // 2-phase digest request
      const hikData = await new Promise((resolve, reject) => {
        const probeOpts = {
          hostname: host,
          port: 443,
          path,
          method: "POST",
          rejectUnauthorized: false,
          timeout: 6000,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": 0,
          },
        };

        const req1 = https.request(probeOpts, (res1) => {
          let b1 = "";
          res1.on("data", (c) => (b1 += c));
          res1.on("end", () => {
            if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
              const auth = res1.headers["www-authenticate"];
              const digest = buildDigestHeader("POST", path, user, pass, auth);

              const postOpts = {
                hostname: host,
                port: 443,
                path,
                method: "POST",
                rejectUnauthorized: false,
                timeout: 8000,
                headers: {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(searchBody),
                  Authorization: digest,
                },
              };

              const req2 = https.request(postOpts, (res2) => {
                let b2 = "";
                res2.on("data", (c) => (b2 += c));
                res2.on("end", () => {
                  try {
                    const parsed = JSON.parse(b2);
                    resolve(parsed);
                  } catch (e) {
                    reject(new Error("Invalid JSON response from Hikvision terminal."));
                  }
                });
              });
              req2.on("error", reject);
              req2.write(searchBody);
              req2.end();
            } else {
              reject(new Error(`Hikvision returned unexpected probe code: ${res1.statusCode}`));
            }
          });
        });

        req1.on("error", reject);
        req1.end();
      });

      const userList = hikData?.UserInfoSearch?.UserInfo || [];
      const totalMatches = hikData?.UserInfoSearch?.totalMatches || userList.length;

      let importedCount = 0;
      let updatedCount = 0;
      const bcrypt = require("bcrypt");
      const defaultPasswordHash = await bcrypt.hash("12345678", 10);

      for (const item of userList) {
        const rawEmpNo = String(item.employeeNo || "").trim();
        const fullName = String(item.name || `Employee ${rawEmpNo}`).trim();
        if (!rawEmpNo) continue;

        // Standardize employee ID format (e.g. EKH-26-0001 or raw if formatted)
        let formattedEmployeeId = rawEmpNo;
        if (!rawEmpNo.toUpperCase().startsWith(prefix)) {
          formattedEmployeeId = `${prefix}-26-${rawEmpNo.padStart(4, "0")}`;
        }

        const candidateEmail = `${rawEmpNo.toLowerCase().replace(/[^a-z0-9]/g, "")}_${organizationId.slice(0, 4)}@company.local`;

        // Check if employee already exists in organization by ID
        const existingEmp = await prisma.user.findFirst({
          where: {
            organizationId,
            OR: [
              { employeeId: formattedEmployeeId },
              { employeeId: rawEmpNo },
              { employeeId: { endsWith: rawEmpNo } },
            ],
          },
        });

        // Extract biometric enrollment counts from terminal record
        const numOfFP = Number(item.numOfFP || 0);
        const numOfFace = Number(item.numOfFace || 0);

        if (existingEmp) {
          // Merge biometric info into existing user permissions JSON
          const curPerms = Array.isArray(existingEmp.permissions) ? existingEmp.permissions : [];
          const updatedPerms = curPerms.filter((p) => typeof p === "string" && !p.startsWith("bio:"));
          if (numOfFP > 0) updatedPerms.push("bio:fingerprint");
          if (numOfFace > 0) updatedPerms.push("bio:face");

          await prisma.user.update({
            where: { id: existingEmp.id },
            data: {
              fullName: fullName || existingEmp.fullName,
              gender: item.gender === "male" ? "MALE" : item.gender === "female" ? "FEMALE" : existingEmp.gender,
              permissions: updatedPerms,
            },
          });
          updatedCount++;
        } else {
          // Create new employee with bio permissions tags
          const newPerms = [];
          if (numOfFP > 0) newPerms.push("bio:fingerprint");
          if (numOfFace > 0) newPerms.push("bio:face");

          await prisma.user.create({
            data: {
              organizationId,
              employeeId: formattedEmployeeId,
              email: candidateEmail,
              passwordHash: defaultPasswordHash,
              fullName,
              gender: item.gender === "male" ? "MALE" : item.gender === "female" ? "FEMALE" : "OTHER",
              role: "EMPLOYEE",
              status: "ACTIVE",
              mustChangePassword: true,
              permissions: newPerms,
            },
          });
          importedCount++;
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

      // Auto-sync latest terminal AcsEvents into biometricRawLog & attendance so Recent Punches are never empty
      let terminalUsers = [];
      let isTerminalReachable = false;

      if (device.ipAddress) {
        try {
          const user = device.username || "admin";
          const pass = device.password || "";
          const host = device.ipAddress;

          // 1. Fetch Users
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
                timeout: 3000,
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
                      timeout: 4000,
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
                  req2.write(searchBody);
                  req2.end();
                } else {
                  reject(new Error("Probe did not return 401"));
                }
              }
            );
            req1.on("error", reject);
            req1.end();
          });

          terminalUsers = userData?.UserInfoSearch?.UserInfo || [];
          isTerminalReachable = true;

          // 2. Fetch Latest 40 AcsEvents and record any new punches
          const eventPath = "/ISAPI/AccessControl/AcsEvent?format=json";
          const eventProbeBody = JSON.stringify({
            AcsEventCond: {
              searchID: "1",
              searchResultPosition: 0,
              maxResults: 1,
              major: 0,
              minor: 0,
            },
          });

          const totalEvMatches = await new Promise((resolve) => {
            const r1 = https.request(
              {
                hostname: host,
                port: 443,
                path: eventPath,
                method: "POST",
                rejectUnauthorized: false,
                timeout: 2500,
                headers: { "Content-Type": "application/json", "Content-Length": 0 },
              },
              (res1) => {
                if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                  const digest = buildDigestHeader("POST", eventPath, user, pass, res1.headers["www-authenticate"]);
                  const r2 = https.request(
                    {
                      hostname: host,
                      port: 443,
                      path: eventPath,
                      method: "POST",
                      rejectUnauthorized: false,
                      timeout: 3000,
                      headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(eventProbeBody),
                        Authorization: digest,
                      },
                    },
                    (res2) => {
                      let b = "";
                      res2.on("data", (c) => (b += c));
                      res2.on("end", () => {
                        try {
                          resolve(Number(JSON.parse(b).AcsEvent?.totalMatches || 0));
                        } catch (e) {
                          resolve(0);
                        }
                      });
                    }
                  );
                  r2.on("error", () => resolve(0));
                  r2.write(eventProbeBody);
                  r2.end();
                } else {
                  resolve(0);
                }
              }
            );
            r1.on("error", () => resolve(0));
            r1.end();
          });

          if (totalEvMatches > 0) {
            const evFetchBody = JSON.stringify({
              AcsEventCond: {
                searchID: "2",
                searchResultPosition: Math.max(0, totalEvMatches - 40),
                maxResults: 40,
                major: 0,
                minor: 0,
              },
            });

            const evList = await new Promise((resolve) => {
              const r1 = https.request(
                {
                  hostname: host,
                  port: 443,
                  path: eventPath,
                  method: "POST",
                  rejectUnauthorized: false,
                  timeout: 2500,
                  headers: { "Content-Type": "application/json", "Content-Length": 0 },
                },
                (res1) => {
                  if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
                    const digest = buildDigestHeader("POST", eventPath, user, pass, res1.headers["www-authenticate"]);
                    const r2 = https.request(
                      {
                        hostname: host,
                        port: 443,
                        path: eventPath,
                        method: "POST",
                        rejectUnauthorized: false,
                        timeout: 4000,
                        headers: {
                          "Content-Type": "application/json",
                          "Content-Length": Buffer.byteLength(evFetchBody),
                          Authorization: digest,
                        },
                      },
                      (res2) => {
                        let b = "";
                        res2.on("data", (c) => (b += c));
                        res2.on("end", () => {
                          try {
                            resolve(JSON.parse(b).AcsEvent?.InfoList || []);
                          } catch (e) {
                            resolve([]);
                          }
                        });
                      }
                    );
                    r2.on("error", () => resolve([]));
                    r2.write(evFetchBody);
                    r2.end();
                  } else {
                    resolve([]);
                  }
                }
              );
              r1.on("error", () => resolve([]));
              r1.end();
            });

            const personEvents = evList.filter(
              (e) => e.major === 5 && (e.minor === 75 || e.minor === 38 || e.minor === 104 || e.minor === 1) && e.employeeNoString
            );

            for (const ev of personEvents) {
              const rawEmp = String(ev.employeeNoString).trim();
              const punchDate = new Date(ev.time);
              if (isNaN(punchDate.getTime())) continue;

              let verificationMode = "FINGERPRINT";
              if (ev.minor === 75) verificationMode = "FACE_SCAN";
              else if (ev.minor === 38) verificationMode = "FINGERPRINT";
              else if (ev.minor === 1) verificationMode = "CARD";
              else if (ev.minor === 104) verificationMode = "FACE_SCAN";

              const userRec = await prisma.user.findFirst({
                where: {
                  organizationId,
                  OR: [
                    { employeeId: rawEmp },
                    { employeeId: { endsWith: rawEmp } },
                    { employeeId: { endsWith: rawEmp.replace(/^0+/, "") } },
                  ],
                },
              });

              if (!userRec) continue;

              const existingLog = await prisma.biometricRawLog.findFirst({
                where: {
                  organizationId,
                  employeeId: userRec.employeeId,
                  punchTime: punchDate,
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

                const utcMidnight = new Date(
                  Date.UTC(punchDate.getUTCFullYear(), punchDate.getUTCMonth(), punchDate.getUTCDate())
                );

                const existingAtt = await prisma.attendance.findUnique({
                  where: {
                    userId_date: {
                      userId: userRec.id,
                      date: utcMidnight,
                    },
                  },
                });

                if (!existingAtt) {
                  await prisma.attendance.create({
                    data: {
                      organizationId,
                      userId: userRec.id,
                      date: utcMidnight,
                      checkInTime: punchDate,
                      currentState: "CHECKED_IN",
                      status: "PRESENT",
                      ipAddress: device.ipAddress,
                      punchInDeviceType: "BIOMETRIC_TERMINAL",
                      punchInAddress: device.locationName,
                    },
                  });
                }
              }
            }
          }
        } catch (err) {
          console.warn("Could not fetch live terminal users/punches:", err.message);
        }
      }

      // Fetch refreshed recent raw punches from this device
      const recentLogs = await prisma.biometricRawLog.findMany({
        where: {
          organizationId,
          deviceSerialNumber: device.deviceSerialNumber,
        },
        orderBy: { punchTime: "desc" },
        take: 30,
      });

      return res.status(200).json({
        device,
        isTerminalReachable,
        totalTerminalUsers: terminalUsers.length,
        terminalUsers: terminalUsers.map((u) => ({
          employeeNo: u.employeeNo,
          name: u.name,
          userType: u.userType,
          hasFingerprint: Number(u.numOfFP || 0) > 0,
          numOfFP: Number(u.numOfFP || 0),
          hasFace: Number(u.numOfFace || 0) > 0,
          numOfFace: Number(u.numOfFace || 0),
        })),
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

      // 1. Probe total matches first
      const probeBody = JSON.stringify({
        AcsEventCond: {
          searchID: "1",
          searchResultPosition: 0,
          maxResults: 1,
          major: 0,
          minor: 0,
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
        return res.status(200).json({ success: true, pulledCount: 0, message: "No event logs found on machine." });
      }

      // 2. Fetch the most recent 100 events from machine
      const fetchStartPos = Math.max(0, totalMatches - 100);
      const fetchBody = JSON.stringify({
        AcsEventCond: {
          searchID: "2",
          searchResultPosition: fetchStartPos,
          maxResults: 100,
          major: 0,
          minor: 0,
        },
      });

      const eventsList = await new Promise((resolve, reject) => {
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
                    "Content-Length": Buffer.byteLength(fetchBody),
                    Authorization: digest,
                  },
                },
                (res2) => {
                  let buf = "";
                  res2.on("data", (c) => (buf += c));
                  res2.on("end", () => {
                    try {
                      const parsed = JSON.parse(buf);
                      resolve(parsed.AcsEvent?.InfoList || []);
                    } catch (e) {
                      resolve([]);
                    }
                  });
                }
              );
              req2.on("error", reject);
              req2.write(fetchBody);
              req2.end();
            } else {
              resolve([]);
            }
          }
        );
        req1.on("error", reject);
        req1.end();
      });

      // Filter events that belong to persons (major: 5, with employeeNoString)
      const personEvents = eventsList.filter(
        (e) => e.major === 5 && (e.minor === 75 || e.minor === 38 || e.minor === 104 || e.minor === 1) && e.employeeNoString
      );

      let recordedCount = 0;
      let attendanceCreatedCount = 0;

      for (const ev of personEvents) {
        const rawEmp = String(ev.employeeNoString).trim();
        const punchDate = new Date(ev.time);
        if (isNaN(punchDate.getTime())) continue;

        // Minor codes: 75=Face, 38=Fingerprint, 1=Card, 104=Face/FP
        let verificationMode = "FINGERPRINT";
        if (ev.minor === 75) verificationMode = "FACE_SCAN";
        else if (ev.minor === 38) verificationMode = "FINGERPRINT";
        else if (ev.minor === 1) verificationMode = "CARD";
        else if (ev.minor === 104) verificationMode = "FACE_SCAN";

        // Find user by employeeId matching
        const userRec = await prisma.user.findFirst({
          where: {
            organizationId,
            OR: [
              { employeeId: rawEmp },
              { employeeId: { endsWith: rawEmp } },
              { employeeId: { endsWith: rawEmp.replace(/^0+/, "") } },
            ],
          },
        });

        if (!userRec) continue;

        // Check if raw log already exists within 60s of punchTime for this user & serial
        const existingLog = await prisma.biometricRawLog.findFirst({
          where: {
            organizationId,
            employeeId: userRec.employeeId,
            punchTime: {
              gte: new Date(punchDate.getTime() - 60000),
              lte: new Date(punchDate.getTime() + 60000),
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

        // Attendance processing: First punch of the day = checkInTime
        const utcMidnight = new Date(
          Date.UTC(punchDate.getUTCFullYear(), punchDate.getUTCMonth(), punchDate.getUTCDate())
        );

        const existingAtt = await prisma.attendance.findUnique({
          where: {
            userId_date: {
              userId: userRec.id,
              date: utcMidnight,
            },
          },
        });

        if (!existingAtt) {
          // First face/fingerprint of the day -> Check in!
          await prisma.attendance.create({
            data: {
              organizationId,
              userId: userRec.id,
              date: utcMidnight,
              checkInTime: punchDate,
              currentState: "CHECKED_IN",
              status: "PRESENT",
              ipAddress: device.ipAddress,
              punchInDeviceType: "BIOMETRIC_TERMINAL",
              punchInAddress: device.locationName,
            },
          });
          attendanceCreatedCount++;
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
