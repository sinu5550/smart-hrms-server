const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const https = require("https");
const multer = require("multer");
const { authenticateToken, requireRoles } = require("../middleware");

// Helper to push/update employee on all active Hikvision biometric terminals
async function syncEmployeeToHikvisionDevices(prisma, organizationId, employee) {
  if (!employee || !employee.fullName) return;
  try {
    const devices = await prisma.biometricDevice.findMany({
      where: { organizationId, status: "ONLINE" },
    });
    if (!devices.length) return;

    // Hikvision does NOT accept dashes in terminal IDs.
    // Strip all hyphens from employeeId: EKH-26-0018 -> EKH260018 (never just '18')
    const terminalEmployeeNo = String(employee.employeeId || "").trim().replace(/-/g, "");

    // Map department to terminal groupId
    let deptGroupId = 1; // Default: General
    if (employee.departmentId) {
      const dept = await prisma.department.findUnique({ where: { id: employee.departmentId } });
      const deptName = (dept?.name || "").toLowerCase();
      if (deptName.includes("manage")) deptGroupId = 2;
      else if (deptName.includes("customer") || deptName.includes("service") || deptName.includes("cs")) deptGroupId = 3;
      else if (deptName.includes("account") || deptName.includes("finance")) deptGroupId = 4;
      else if (deptName.includes("market") || deptName.includes("sales")) deptGroupId = 5;
      else if (deptName.includes("supply") || deptName.includes("logistic")) deptGroupId = 6;
      else if (deptName.includes("hr") || deptName.includes("admin")) deptGroupId = 7;
      else if (deptName.includes("it") || deptName.includes("software")) deptGroupId = 8;
    }

    const path = "/ISAPI/AccessControl/UserInfo/SetUp?format=json";
    const setupPayload = JSON.stringify({
      UserInfo: {
        employeeNo: terminalEmployeeNo,
        name: employee.fullName.slice(0, 32).trim(),
        userType: "normal",
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

    for (const dev of devices) {
      if (!dev.ipAddress) continue;
      const host = dev.ipAddress;
      const user = dev.username || "admin";
      const pass = dev.password || "";

      new Promise((resolve, reject) => {
        const req1 = https.request(
          {
            hostname: host,
            port: 443,
            path,
            method: "PUT",
            rejectUnauthorized: false,
            timeout: 5000,
            headers: { "Content-Type": "application/json", "Content-Length": 0 },
          },
          (res1) => {
            if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
              const authHeader = res1.headers["www-authenticate"];
              const parts = {};
              authHeader.replace(/^Digest\s+/, "").split(/,\s*/).forEach((p) => {
                const idx = p.indexOf("=");
                if (idx !== -1) parts[p.slice(0, idx).trim()] = p.slice(idx + 1).replace(/"/g, "").trim();
              });
              const realm = parts.realm || "";
              const nonce = parts.nonce || "";
              const qop = parts.qop || "";
              const cnonce = crypto.randomBytes(8).toString("hex");
              const nc = "00000001";
              const ha1 = crypto.createHash("md5").update(`${user}:${realm}:${pass}`).digest("hex");
              const ha2 = crypto.createHash("md5").update(`PUT:${path}`).digest("hex");
              const digest = qop.includes("auth")
                ? `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${path}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${crypto.createHash("md5").update(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`).digest("hex")}"`
                : `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${path}", response="${crypto.createHash("md5").update(`${ha1}:${nonce}:${ha2}`).digest("hex")}"`;

              const req2 = https.request(
                {
                  hostname: host,
                  port: 443,
                  path,
                  method: "PUT",
                  rejectUnauthorized: false,
                  timeout: 5000,
                  headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(setupPayload),
                    Authorization: digest,
                  },
                },
                (res2) => {
                  resolve(res2.statusCode);
                }
              );
              req2.on("error", resolve);
              req2.write(setupPayload);
              req2.end();
            } else {
              resolve(res1.statusCode);
            }
          }
        );
        req1.on("error", resolve);
        req1.end();
      }).catch((e) => console.warn(`Hikvision auto-sync skipped for ${dev.deviceName}:`, e.message));
    }
  } catch (err) {
    console.warn("syncEmployeeToHikvisionDevices error:", err.message);
  }
}

// Helper to push employee face picture to all active Hikvision biometric terminals
async function pushFaceToHikvisionDevices(prisma, organizationId, employee, imageBuffer) {
  if (!employee || !employee.employeeId || !imageBuffer) return;
  try {
    const devices = await prisma.biometricDevice.findMany({
      where: { organizationId, status: "ONLINE" },
    });
    if (!devices.length) return;

    // Hikvision does NOT accept dashes in terminal IDs.
    // Strip all hyphens from employeeId: EKH-26-0018 -> EKH260018 (never just '18')
    const terminalEmployeeNo = String(employee.employeeId || "").trim().replace(/-/g, "");

    const path = "/ISAPI/Intelligent/FDLib/FDSetUp?format=json";
    const boundary = "----WebKitFormBoundary" + crypto.randomBytes(16).toString("hex");
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
      `Content-Length: ${imageBuffer.length}\r\n\r\n`;

    const tail = `\r\n--${boundary}--\r\n`;
    const multipartBody = Buffer.concat([
      Buffer.from(head, "utf-8"),
      imageBuffer,
      Buffer.from(tail, "utf-8"),
    ]);

    for (const dev of devices) {
      if (!dev.ipAddress) continue;
      const host = dev.ipAddress;
      const user = dev.username || "admin";
      const pass = dev.password || "";

      new Promise((resolve) => {
        const req1 = https.request(
          {
            hostname: host,
            port: 443,
            path,
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
              const authHeader = res1.headers["www-authenticate"];
              const parts = {};
              authHeader
                .replace(/^Digest\s+/, "")
                .split(/,\s*/)
                .forEach((p) => {
                  const idx = p.indexOf("=");
                  if (idx !== -1)
                    parts[p.slice(0, idx).trim()] = p
                      .slice(idx + 1)
                      .replace(/"/g, "")
                      .trim();
                });
              const realm = parts.realm || "";
              const nonce = parts.nonce || "";
              const qop = parts.qop || "";
              const cnonce = crypto.randomBytes(8).toString("hex");
              const nc = "00000001";
              const ha1 = crypto
                .createHash("md5")
                .update(`${user}:${realm}:${pass}`)
                .digest("hex");
              const ha2 = crypto
                .createHash("md5")
                .update(`PUT:${path}`)
                .digest("hex");
              const digest = qop.includes("auth")
                ? `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${path}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${crypto
                    .createHash("md5")
                    .update(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)
                    .digest("hex")}"`
                : `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${path}", response="${crypto
                    .createHash("md5")
                    .update(`${ha1}:${nonce}:${ha2}`)
                    .digest("hex")}"`;

              const req2 = https.request(
                {
                  hostname: host,
                  port: 443,
                  path,
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
                  let b = "";
                  res2.on("data", (c) => (b += c));
                  res2.on("end", async () => {
                    if (res2.statusCode === 200) {
                      try {
                        const cur = await prisma.user.findUnique({
                          where: { id: employee.id },
                          select: { permissions: true },
                        });
                        const perms = Array.isArray(cur?.permissions) ? cur.permissions : [];
                        if (!perms.includes("bio:face")) {
                          await prisma.user.update({
                            where: { id: employee.id },
                            data: { permissions: [...perms, "bio:face"] },
                          });
                        }
                      } catch (dbErr) {
                        console.warn("DB bio:face permission update warning:", dbErr.message);
                      }
                    }
                    resolve({ statusCode: res2.statusCode, data: b });
                  });
                }
              );
              req2.on("error", resolve);
              req2.write(multipartBody);
              req2.end();
            } else {
              resolve({ statusCode: res1.statusCode });
            }
          }
        );
        req1.on("error", resolve);
        req1.end();
      }).catch((e) =>
        console.warn(`Face upload to Hikvision skipped for ${dev.deviceName}:`, e.message)
      );
    }
  } catch (err) {
    console.warn("pushFaceToHikvisionDevices error:", err.message);
  }
}

const upload = multer({
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.match(/^image\/(png|jpeg|jpg|webp)$/)) {
      return cb(new Error("Only PNG, JPEG, and WEBP image formats are supported."));
    }
    cb(null, true);
  },
});

function createEmployeesRouter(prisma) {
  const router = express.Router();

  router.use(authenticateToken);
  router.use(requireRoles("HR", "ADMIN"));

  // GET /api/employees/next-id
  router.get("/next-id", async (req, res, next) => {
    try {
      const org = await prisma.organization.findUnique({
        where: { id: req.user.organizationId },
        select: { employeePrefix: true },
      });
      const prefix = (org?.employeePrefix || "EKH").trim().toUpperCase();
      const currentYearShort = new Date().getFullYear().toString().slice(-2);
      const prefixPattern = `${prefix}-${currentYearShort}-`;

      const employees = await prisma.user.findMany({
        where: {
          organizationId: req.user.organizationId,
          employeeId: { startsWith: prefixPattern },
        },
        select: { employeeId: true },
      });

      let maxSerial = 0;
      for (const emp of employees) {
        const parts = emp.employeeId.split("-");
        if (parts.length === 3) {
          const serialNum = parseInt(parts[2], 10);
          if (!isNaN(serialNum) && serialNum > maxSerial) {
            maxSerial = serialNum;
          }
        }
      }

      const nextSerial = (maxSerial + 1).toString().padStart(4, "0");
      const nextEmployeeId = `${prefix}-${currentYearShort}-${nextSerial}`;

      return res.status(200).json({ nextEmployeeId, prefix });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/employees
  router.get("/", async (req, res, next) => {
    try {
      const { search, status, bloodGroup, departmentId } = req.query;
      const where = { organizationId: req.user.organizationId, isDeleted: false };

      if (status && status !== "ALL") {
        where.status = status;
      }
      if (bloodGroup && bloodGroup !== "ALL") {
        where.bloodGroup = bloodGroup;
      }
      if (departmentId && departmentId !== "ALL") {
        where.departmentId = departmentId;
      }
      if (search) {
        where.OR = [
          { fullName: { contains: search, mode: "insensitive" } },
          { employeeId: { contains: search, mode: "insensitive" } },
          { phone: { contains: search } },
          { email: { contains: search, mode: "insensitive" } },
        ];
      }

      const org = await prisma.organization.findUnique({
        where: { id: req.user.organizationId },
        select: { ownerEmail: true },
      });
      const ownerEmail = org?.ownerEmail?.toLowerCase();

      // The Organization Owner must NOT be listed in the employee directory
      if (ownerEmail) {
        where.email = { not: ownerEmail };
      }

      const employees = await prisma.user.findMany({
        where,
        select: {
          id: true,
          employeeId: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          status: true,
          bloodGroup: true,
          avatarUrl: true,
          attendanceExempt: true,
          permissions: true,
          joiningDate: true,
          gender: true,
          dateOfBirth: true,
          presentAddress: true,
          permanentAddress: true,
          emergencyContactName: true,
          emergencyContactPhone: true,
          emergencyContactRelation: true,
          nidOrPassport: true,
          departmentId: true,
          designationId: true,
          shiftId: true,
          customRoleId: true,
          department: { select: { id: true, name: true } },
          designation: { select: { id: true, name: true } },
          shift: { select: { id: true, shiftName: true, startTime: true, endTime: true } },
          customRole: { select: { id: true, name: true, permissions: true } },
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });

      const result = employees.map((emp) => ({
        ...emp,
        isOwner: false,
      }));

      return res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/employees/:id
  router.get("/:id", async (req, res, next) => {
    try {
      const org = await prisma.organization.findUnique({
        where: { id: req.user.organizationId },
        select: { ownerEmail: true },
      });
      const ownerEmail = org?.ownerEmail?.toLowerCase();

      const user = await prisma.user.findFirst({
        where: { id: req.params.id, organizationId: req.user.organizationId },
        select: {
          id: true,
          employeeId: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          status: true,
          bloodGroup: true,
          avatarUrl: true,
          attendanceExempt: true,
          permissions: true,
          joiningDate: true,
          resignationDate: true,
          gender: true,
          dateOfBirth: true,
          presentAddress: true,
          permanentAddress: true,
          emergencyContactName: true,
          emergencyContactPhone: true,
          emergencyContactRelation: true,
          nidOrPassport: true,
          departmentId: true,
          designationId: true,
          shiftId: true,
          customRoleId: true,
          department: { select: { id: true, name: true } },
          designation: { select: { id: true, name: true } },
          shift: { select: { id: true, shiftName: true, startTime: true, endTime: true } },
          customRole: { select: { id: true, name: true, permissions: true } },
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!user) {
        return res.status(404).json({ message: "Employee not found." });
      }

      return res.status(200).json({
        ...user,
        isOwner: Boolean(ownerEmail && user.email?.toLowerCase() === ownerEmail),
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/employees
  router.post("/", async (req, res, next) => {
    try {
      const dto = req.body || {};
      const organizationId = req.user.organizationId;

      if (dto.departmentId) {
        const dept = await prisma.department.findFirst({
          where: { id: dto.departmentId, organizationId },
        });
        if (!dept) return res.status(404).json({ message: "Department is not in this organization." });
      }

      if (dto.designationId) {
        const desig = await prisma.designation.findFirst({
          where: { id: dto.designationId, organizationId },
        });
        if (!desig) return res.status(404).json({ message: "Designation is not in this organization." });
      }

      const organization = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { employeePrefix: true },
      });
      if (!organization) return res.status(404).json({ message: "Organization not found." });

      const employeeId = (dto.employeeId || "").trim().toUpperCase();
      if (!employeeId.startsWith(`${organization.employeePrefix}-`)) {
        return res.status(400).json({
          message: `Employee ID must start with your organization's ${organization.employeePrefix} prefix.`,
        });
      }

      const existingId = await prisma.user.findFirst({
        where: { organizationId, employeeId },
      });
      if (existingId) {
        return res.status(409).json({
          message: `Employee ID "${employeeId}" is already taken in this organization.`,
        });
      }

      const existingEmail = await prisma.user.findFirst({
        where: { email: (dto.email || "").trim().toLowerCase() },
      });
      if (existingEmail) {
        return res.status(409).json({
          message: `Work Email "${dto.email}" is already registered in the system.`,
        });
      }

      if (dto.phone) {
        const existingPhone = await prisma.user.findFirst({
          where: { organizationId, phone: dto.phone },
        });
        if (existingPhone) {
          return res.status(409).json({
            message: `Phone number "${dto.phone}" is already assigned to another employee.`,
          });
        }
      }

      let finalPasswordHash = null;
      let initialPassword = null;

      if (dto.passwordHash && typeof dto.passwordHash === "string" && dto.passwordHash.trim()) {
        finalPasswordHash = dto.passwordHash.trim();
        initialPassword = "(Set by applicant during registration)";
      } else if (dto.password?.trim()) {
        initialPassword = dto.password.trim();
        finalPasswordHash = await bcrypt.hash(initialPassword, 12);
      } else {
        initialPassword = crypto.randomBytes(8).toString("hex");
        finalPasswordHash = await bcrypt.hash(initialPassword, 12);
      }

      let permissions = [];
      if (dto.customRoleId) {
        const customRole = await prisma.customRole.findUnique({ where: { id: dto.customRoleId } });
        permissions = customRole?.permissions || [];
      }

      const user = await prisma.user.create({
        data: {
          organizationId,
          employeeId,
          email: dto.email.toLowerCase().trim(),
          fullName: dto.fullName,
          phone: dto.phone,
          role: dto.role || "EMPLOYEE",
          departmentId: dto.departmentId,
          designationId: dto.designationId,
          shiftId: dto.shiftId,
          customRoleId: dto.customRoleId,
          permissions,
          passwordHash: finalPasswordHash,
          mustChangePassword: !dto.password?.trim() && !dto.passwordHash?.trim(),
          bloodGroup: dto.bloodGroup,
          presentAddress: dto.presentAddress,
          permanentAddress: dto.permanentAddress,
          emergencyContactName: dto.emergencyContactName,
          emergencyContactPhone: dto.emergencyContactPhone,
          emergencyContactRelation: dto.emergencyContactRelation,
          nidOrPassport: dto.nidOrPassport,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
          gender: dto.gender,
          joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : undefined,
        },
        select: {
          id: true,
          employeeId: true,
          email: true,
          fullName: true,
          role: true,
          status: true,
        },
      });

      // Auto-sync new employee to all active Hikvision devices
      syncEmployeeToHikvisionDevices(prisma, organizationId, user).catch((err) =>
        console.warn("Auto-sync to Hikvision on create failed:", err.message)
      );

      return res.status(201).json({
        user,
        initialTemporaryPassword: initialPassword,
      });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/employees/:id
  router.patch("/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      const dto = req.body || {};
      const organizationId = req.user.organizationId;

      // Permission checks for non-ADMIN users:
      if (req.user.role !== "ADMIN" && req.user.role !== "PLATFORM_ADMIN") {
        const caller = await prisma.user.findUnique({
          where: { id: req.user.userId },
          select: {
            role: true,
            permissions: true,
            customRole: { select: { permissions: true } },
            organization: { select: { ownerEmail: true } },
          },
        });

        const isCallerOwner = Boolean(
          caller?.organization?.ownerEmail &&
          caller.organization.ownerEmail.toLowerCase() === req.user.email.toLowerCase()
        );

        if (!isCallerOwner) {
          const directPerms = Array.isArray(caller?.permissions) ? caller.permissions : [];
          const rolePerms = Array.isArray(caller?.customRole?.permissions) ? caller.customRole.permissions : [];
          const callerPerms = Array.from(new Set([...directPerms, ...rolePerms]));

          // If updating role:
          if (dto.role && dto.role !== undefined && !callerPerms.includes("employees.roles")) {
            return res.status(403).json({
              message: "Access denied: You do not possess the 'employees.roles' privilege to change employee roles.",
            });
          }

          // If updating permissions or customRoleId:
          if (
            (dto.permissions !== undefined || dto.customRoleId !== undefined) &&
            !callerPerms.includes("employees.permissions")
          ) {
            return res.status(403).json({
              message: "Access denied: You do not possess the 'employees.permissions' privilege to grant or modify permissions.",
            });
          }

          // If updating attendance exemption status:
          if (dto.attendanceExempt !== undefined && !callerPerms.includes("attendance.exempt")) {
            return res.status(403).json({
              message: "Access denied: You do not possess the 'attendance.exempt' privilege to exempt employees from attendance.",
            });
          }

          // General profile editing:
          if (!callerPerms.includes("employees.edit") && !callerPerms.includes("employees.permissions") && !callerPerms.includes("employees.roles") && !callerPerms.includes("attendance.exempt")) {
            return res.status(403).json({
              message: "Access denied: You do not possess the required privilege to update personnel.",
            });
          }
        }
      }

      const user = await prisma.user.findFirst({ where: { id, organizationId } });
      if (!user || user.isDeleted) {
        return res.status(404).json({ message: "Employee not found or already deleted." });
      }

      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { ownerEmail: true },
      });
      const isOwner = Boolean(org?.ownerEmail && org.ownerEmail.toLowerCase() === user.email.toLowerCase());
      const isCallerTheOwner = Boolean(
        org?.ownerEmail && org.ownerEmail.toLowerCase() === req.user.email.toLowerCase()
      );

      // Only the Owner can modify Owner details
      if (isOwner && !isCallerTheOwner) {
        return res.status(403).json({
          message: "Access denied: Organization Owner details can only be managed by the Owner.",
        });
      }

      if (isOwner && dto.role && dto.role !== user.role) {
        return res.status(403).json({
          message: "Organization owner system role is locked and cannot be demoted.",
        });
      }

      if (dto.departmentId) {
        const dept = await prisma.department.findFirst({ where: { id: dto.departmentId, organizationId } });
        if (!dept) return res.status(404).json({ message: "Department is not in this organization." });
      }
      if (dto.designationId) {
        const desig = await prisma.designation.findFirst({ where: { id: dto.designationId, organizationId } });
        if (!desig) return res.status(404).json({ message: "Designation is not in this organization." });
      }

      const normalizedEmail = dto.email?.trim().toLowerCase();
      if (normalizedEmail && normalizedEmail !== user.email) {
        const emailCollision = await prisma.user.findFirst({ where: { email: normalizedEmail } });
        if (emailCollision && emailCollision.id !== id) {
          return res.status(409).json({ message: "Email is already assigned to another employee." });
        }
      }

      const trimmedEmpId = dto.employeeId?.trim();
      if (trimmedEmpId && trimmedEmpId !== user.employeeId) {
        const idCollision = await prisma.user.findFirst({
          where: { organizationId, employeeId: trimmedEmpId },
        });
        if (idCollision && idCollision.id !== id) {
          return res.status(409).json({ message: `Employee ID "${trimmedEmpId}" is already assigned to another employee.` });
        }
      }

      if (dto.phone && dto.phone !== user.phone) {
        const phoneCollision = await prisma.user.findFirst({ where: { organizationId, phone: dto.phone } });
        if (phoneCollision && phoneCollision.id !== id) {
          return res.status(409).json({ message: "Phone number is already assigned to another employee." });
        }
      }

      let permissionsData = {};
      if (Array.isArray(dto.permissions)) {
        permissionsData = { permissions: dto.permissions };
      } else if (dto.customRoleId && dto.customRoleId !== user.customRoleId) {
        const roleRecord = await prisma.customRole.findUnique({ where: { id: dto.customRoleId } });
        permissionsData = { permissions: roleRecord?.permissions || [] };
      }

      let passwordData = {};
      if (dto.password && typeof dto.password === "string" && dto.password.trim().length >= 6) {
        const hashedPassword = await bcrypt.hash(dto.password.trim(), 12);
        passwordData = {
          passwordHash: hashedPassword,
          mustChangePassword: false,
        };
      }

      const updated = await prisma.user.update({
        where: { id },
        data: {
          employeeId: trimmedEmpId || undefined,
          fullName: dto.fullName,
          email: normalizedEmail,
          phone: dto.phone,
          role: dto.role,
          departmentId: dto.departmentId,
          designationId: dto.designationId,
          shiftId: dto.shiftId,
          customRoleId: dto.customRoleId,
          bloodGroup: dto.bloodGroup,
          presentAddress: dto.presentAddress,
          permanentAddress: dto.permanentAddress,
          emergencyContactName: dto.emergencyContactName,
          emergencyContactPhone: dto.emergencyContactPhone,
          emergencyContactRelation: dto.emergencyContactRelation,
          nidOrPassport: dto.nidOrPassport,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
          gender: dto.gender,
          joiningDate: dto.joiningDate ? new Date(dto.joiningDate) : undefined,
          avatarUrl: dto.avatarUrl,
          attendanceExempt: dto.attendanceExempt !== undefined ? Boolean(dto.attendanceExempt) : undefined,
          ...passwordData,
          ...permissionsData,
        },
        select: {
          id: true,
          employeeId: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          status: true,
          bloodGroup: true,
          avatarUrl: true,
          attendanceExempt: true,
          permissions: true,
          shiftId: true,
          shift: { select: { id: true, shiftName: true, startTime: true, endTime: true } },
          updatedAt: true,
        },
      });

      // Auto-sync updated employee details to all active Hikvision devices
      syncEmployeeToHikvisionDevices(prisma, organizationId, updated).catch((err) =>
        console.warn("Auto-sync to Hikvision on update failed:", err.message)
      );

      // If avatarUrl was modified/provided, download and push face to terminal
      if (dto.avatarUrl && dto.avatarUrl.startsWith("http")) {
        fetch(dto.avatarUrl)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((ab) => {
            if (ab) {
              const buf = Buffer.from(ab);
              return pushFaceToHikvisionDevices(prisma, organizationId, updated, buf);
            }
          })
          .catch((err) => console.warn("Syncing updated avatarUrl to Hikvision failed:", err.message));
      }

      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/employees/:id/status
  router.patch("/:id/status", async (req, res, next) => {
    try {
      const { id } = req.params;
      const { status } = req.body || {};
      const organizationId = req.user.organizationId;

      const user = await prisma.user.findFirst({ where: { id, organizationId } });
      if (!user || user.isDeleted) {
        return res.status(404).json({ message: "Employee not found or already deleted." });
      }

      const organization = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { ownerEmail: true },
      });

      if (organization?.ownerEmail && organization.ownerEmail.toLowerCase() === user.email.toLowerCase()) {
        return res.status(403).json({
          message: "Organization owner status cannot be changed or deactivated.",
        });
      }

      const invalidatingStatuses = ["RESIGNED", "TERMINATED", "SUSPENDED"];
      const shouldInvalidateTokens = invalidatingStatuses.includes(status);

      const updated = await prisma.user.update({
        where: { id },
        data: {
          status,
          ...(shouldInvalidateTokens ? { refreshTokenHash: null } : {}),
          ...(status === "RESIGNED" ? { resignationDate: new Date() } : {}),
        },
        select: { id: true, employeeId: true, status: true, updatedAt: true },
      });

      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/employees/:id
  router.delete("/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      const { confirmationText } = req.body || {};
      const organizationId = req.user.organizationId;

      const user = await prisma.user.findFirst({ where: { id, organizationId } });
      if (!user || user.isDeleted) {
        return res.status(404).json({
          message: "Employee record does not exist or has already been removed.",
        });
      }

      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { ownerEmail: true },
      });

      if (org?.ownerEmail && org.ownerEmail.toLowerCase() === user.email.toLowerCase()) {
        return res.status(403).json({ message: "Organization owner account cannot be deleted." });
      }

      const expectedConfirmation = `DELETE_EMPLOYEE_${user.employeeId}`;
      if (confirmationText !== expectedConfirmation) {
        return res.status(400).json({
          message: "Action aborted: Explicit deletion confirmation string mismatched.",
        });
      }

      // Hard delete employee record permanently from database
      await prisma.user.delete({
        where: { id },
      });

      return res.status(200).json({
        id,
        employeeId: user.employeeId,
        deleted: true,
        message: `Employee ${user.fullName} (${user.employeeId}) permanently deleted from database.`,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/employees/:id/avatar
  router.post("/:id/avatar", upload.single("file"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const organizationId = req.user.organizationId;

      if (!req.file) {
        return res.status(400).json({ message: "Avatar image file must be provided." });
      }

      const user = await prisma.user.findFirst({ where: { id, organizationId } });
      if (!user || user.isDeleted) {
        return res.status(404).json({ message: "Employee not found." });
      }

      const cloudName = process.env.CLOUDINARY_CLOUD_NAME || "jawcusfd";
      const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET || "ekhone-hrms";

      const base64Data = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      const formData = new FormData();
      formData.append("file", base64Data);
      formData.append("upload_preset", uploadPreset);
      formData.append("folder", "hrms/employee-avatars");

      const uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
        method: "POST",
        body: formData,
      });

      const data = await uploadRes.json();
      if (!uploadRes.ok || !data.secure_url) {
        return res.status(500).json({
          message: `Cloudinary Upload Error: ${data.error?.message || "Failed to upload image"}`,
        });
      }

      const updated = await prisma.user.update({
        where: { id },
        data: { avatarUrl: data.secure_url },
        select: { id: true, employeeId: true, fullName: true, avatarUrl: true },
      });

      // Auto-push the uploaded face image to all active Hikvision devices
      if (req.file?.buffer) {
        pushFaceToHikvisionDevices(prisma, organizationId, updated, req.file.buffer).catch((err) =>
          console.warn("Auto-push face to Hikvision failed:", err.message)
        );
      }

      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/employees/bulk-import (HR, ADMIN)
  router.post("/bulk-import", async (req, res, next) => {
    try {
      const { rows } = req.body || {};
      const organizationId = req.user.organizationId;

      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: "No employee rows provided for import." });
      }

      const defaultPassword = await bcrypt.hash("Employee@123", 10);
      const imported = [];
      const skipped = [];

      for (const row of rows) {
        const email = (row.email || "").trim().toLowerCase();
        const fullName = (row.fullName || "").trim();
        const employeeId = (row.employeeId || "").trim();

        if (!email || !fullName || !employeeId) {
          skipped.push({ row, reason: "Missing required fullName, employeeId, or email." });
          continue;
        }

        const existing = await prisma.user.findFirst({
          where: {
            organizationId,
            OR: [{ email }, { employeeId }],
          },
        });

        if (existing) {
          skipped.push({ row, reason: "Email or Employee ID already exists." });
          continue;
        }

        const user = await prisma.user.create({
          data: {
            organizationId,
            fullName,
            employeeId,
            email,
            phone: row.phone ? String(row.phone).trim() : null,
            role: row.role === "HR" ? "HR" : "EMPLOYEE",
            bloodGroup: row.bloodGroup || null,
            departmentId: row.departmentId || null,
            passwordHash: defaultPassword,
            mustChangePassword: true,
          },
          select: { id: true, employeeId: true, fullName: true, email: true },
        });

        imported.push(user);
      }

      return res.status(200).json({
        success: true,
        totalImported: imported.length,
        totalSkipped: skipped.length,
        imported,
        skipped,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/employees/bulk-delete (Admin/HR)
  router.post("/bulk-delete", async (req, res, next) => {
    try {
      const { ids } = req.body || {};
      const organizationId = req.user.organizationId;

      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "No employee IDs provided for deletion." });
      }

      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { ownerEmail: true },
      });
      const ownerEmail = org?.ownerEmail?.toLowerCase();

      // Find valid target users in this organization excluding owner
      const targetUsers = await prisma.user.findMany({
        where: {
          id: { in: ids },
          organizationId,
          isDeleted: false,
          ...(ownerEmail ? { email: { not: ownerEmail } } : {}),
        },
        select: { id: true, employeeId: true, email: true },
      });

      if (targetUsers.length === 0) {
        return res.status(400).json({ message: "No deletable employees found among the provided IDs." });
      }

      const validIds = targetUsers.map((u) => u.id);

      // Hard delete selected employee records permanently from database
      const result = await prisma.user.deleteMany({
        where: {
          id: { in: validIds },
          organizationId,
        },
      });

      return res.status(200).json({
        success: true,
        deletedCount: result.count,
        message: `Successfully and permanently deleted ${result.count} employee(s) from database.`,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createEmployeesRouter };
