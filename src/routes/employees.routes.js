const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const multer = require("multer");
const { authenticateToken, requireRoles } = require("../middleware");

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
        isOwner: Boolean(ownerEmail && emp.email?.toLowerCase() === ownerEmail),
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

      const initialPassword = dto.password?.trim()
        ? dto.password.trim()
        : crypto.randomBytes(8).toString("hex");
      const passwordHash = await bcrypt.hash(initialPassword, 12);

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
          passwordHash,
          mustChangePassword: !dto.password?.trim(),
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

      const user = await prisma.user.findFirst({ where: { id, organizationId } });
      if (!user || user.isDeleted) {
        return res.status(404).json({ message: "Employee not found or already deleted." });
      }

      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { ownerEmail: true },
      });
      const isOwner = Boolean(org?.ownerEmail && org.ownerEmail.toLowerCase() === user.email.toLowerCase());

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

      if (dto.phone && dto.phone !== user.phone) {
        const phoneCollision = await prisma.user.findFirst({ where: { organizationId, phone: dto.phone } });
        if (phoneCollision && phoneCollision.id !== id) {
          return res.status(409).json({ message: "Phone number is already assigned to another employee." });
        }
      }

      let permissionsData = {};
      if (dto.permissions) {
        permissionsData = { permissions: dto.permissions };
      } else if (dto.customRoleId && dto.customRoleId !== user.customRoleId) {
        const roleRecord = await prisma.customRole.findUnique({ where: { id: dto.customRoleId } });
        permissionsData = { permissions: roleRecord?.permissions || [] };
      }

      const updated = await prisma.user.update({
        where: { id },
        data: {
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
          permissions: true,
          shiftId: true,
          shift: { select: { id: true, shiftName: true, startTime: true, endTime: true } },
          updatedAt: true,
        },
      });

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

      const deleted = await prisma.user.update({
        where: { id },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
          status: "TERMINATED",
          refreshTokenHash: null,
        },
        select: {
          id: true,
          employeeId: true,
          isDeleted: true,
          deletedAt: true,
        },
      });

      return res.status(200).json(deleted);
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
        select: { id: true, employeeId: true, avatarUrl: true },
      });

      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createEmployeesRouter };
