const express = require("express");
const { authenticateToken, requireRoles } = require("../middleware");

function createCoreHrRouter(prisma) {
  const router = express.Router();

  router.use(authenticateToken);
  router.use(requireRoles("ADMIN", "HR"));

  // 1. Branches
  router.get("/branches", async (req, res, next) => {
    try {
      const branches = await prisma.branch.findMany({
        where: { organizationId: req.user.organizationId },
        include: { _count: { select: { users: true } } },
        orderBy: { createdAt: "asc" },
      });
      return res.status(200).json(branches);
    } catch (err) {
      next(err);
    }
  });

  router.post("/branches", async (req, res, next) => {
    try {
      const dto = req.body || {};
      const organizationId = req.user.organizationId;
      const code = (dto.code || "").toUpperCase();

      const existing = await prisma.branch.findFirst({
        where: { organizationId, code },
      });
      if (existing) {
        return res.status(400).json({ message: `Branch code "${dto.code}" is already in use.` });
      }

      const created = await prisma.branch.create({
        data: {
          organizationId,
          name: dto.name,
          code,
          address: dto.address || null,
          city: dto.city || null,
          phone: dto.phone || null,
          email: dto.email || null,
          isHeadOffice: dto.isHeadOffice || false,
        },
      });
      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/branches/:id", async (req, res, next) => {
    try {
      const branch = await prisma.branch.findFirst({
        where: { id: req.params.id, organizationId: req.user.organizationId },
      });
      if (!branch) {
        return res.status(404).json({ message: "Branch not found." });
      }
      const deleted = await prisma.branch.delete({ where: { id: req.params.id } });
      return res.status(200).json(deleted);
    } catch (err) {
      next(err);
    }
  });

  // 2. Holidays
  router.get("/holidays", async (req, res, next) => {
    try {
      const holidays = await prisma.holiday.findMany({
        where: { organizationId: req.user.organizationId },
        orderBy: { fromDate: "asc" },
      });
      return res.status(200).json(holidays);
    } catch (err) {
      next(err);
    }
  });

  router.post("/holidays", async (req, res, next) => {
    try {
      const dto = req.body || {};
      const from = new Date(dto.fromDate);
      const to = new Date(dto.toDate);
      const totalDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)) + 1);

      const created = await prisma.holiday.create({
        data: {
          organizationId: req.user.organizationId,
          title: dto.title,
          fromDate: from,
          toDate: to,
          totalDays,
          holidayType: dto.holidayType || "PUBLIC",
          description: dto.description || null,
        },
      });
      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/holidays/:id", async (req, res, next) => {
    try {
      const deleted = await prisma.holiday.delete({ where: { id: req.params.id } });
      return res.status(200).json(deleted);
    } catch (err) {
      next(err);
    }
  });

  // 3. Job Grades
  router.get("/grades", async (req, res, next) => {
    try {
      const grades = await prisma.jobGrade.findMany({
        where: { organizationId: req.user.organizationId },
        include: { _count: { select: { users: true } } },
        orderBy: { gradeLevel: "asc" },
      });
      return res.status(200).json(grades);
    } catch (err) {
      next(err);
    }
  });

  router.post("/grades", async (req, res, next) => {
    try {
      const dto = req.body || {};
      const created = await prisma.jobGrade.create({
        data: {
          organizationId: req.user.organizationId,
          gradeName: dto.gradeName,
          gradeLevel: Number(dto.gradeLevel) || 1,
          minBasic: dto.minBasic || 0,
          maxBasic: dto.maxBasic || 0,
          description: dto.description || null,
        },
      });
      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/grades/:id", async (req, res, next) => {
    try {
      const deleted = await prisma.jobGrade.delete({ where: { id: req.params.id } });
      return res.status(200).json(deleted);
    } catch (err) {
      next(err);
    }
  });

  // 4. Gazette Wage Rules
  router.get("/gazette", async (req, res, next) => {
    try {
      const rules = await prisma.gazetteRule.findMany({
        where: { organizationId: req.user.organizationId },
        orderBy: { createdAt: "asc" },
      });
      return res.status(200).json(rules);
    } catch (err) {
      next(err);
    }
  });

  router.post("/gazette", async (req, res, next) => {
    try {
      const dto = req.body || {};
      const organizationId = req.user.organizationId;

      if (dto.isDefault) {
        await prisma.gazetteRule.updateMany({
          where: { organizationId },
          data: { isDefault: false },
        });
      }

      const created = await prisma.gazetteRule.create({
        data: {
          organizationId,
          gazetteName: dto.gazetteName,
          basicPercentage: dto.basicPercentage ?? 50.0,
          houseRentPercentage: dto.houseRentPercentage ?? 25.0,
          medicalAllowanceFixed: dto.medicalAllowanceFixed ?? 4500.0,
          conveyanceAllowanceFixed: dto.conveyanceAllowanceFixed ?? 3500.0,
          foodAllowanceFixed: dto.foodAllowanceFixed ?? 2500.0,
          overtimeMultiplier: dto.overtimeMultiplier ?? 2.0,
          isDefault: dto.isDefault ?? false,
        },
      });
      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // 5. ID Card Template Studio
  router.get("/id-card-templates", async (req, res, next) => {
    try {
      const templates = await prisma.idCardTemplate.findMany({
        where: { organizationId: req.user.organizationId },
        orderBy: { createdAt: "desc" },
      });
      return res.status(200).json(templates);
    } catch (err) {
      next(err);
    }
  });

  router.post("/id-card-templates", async (req, res, next) => {
    try {
      const dto = req.body || {};
      const created = await prisma.idCardTemplate.create({
        data: {
          organizationId: req.user.organizationId,
          templateName: dto.templateName || "Default Corporate ID",
          primaryColor: dto.primaryColor || "#047857",
          accentColor: dto.accentColor || "#0f172a",
          showBloodGroup: dto.showBloodGroup ?? true,
          showEmergencyContact: dto.showEmergencyContact ?? true,
          showQrCode: dto.showQrCode ?? true,
          showBarcode: dto.showBarcode ?? false,
          customFooterText: dto.customFooterText || "If found, return to office administration.",
          isDefault: true,
        },
      });
      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // 6. Employment Status Configurations (Custom statuses & Attendance calculation selector)
  router.get("/employment-statuses", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const statuses = await prisma.$queryRawUnsafe(
        "SELECT id, name, code, color, count_in_attendance as \"countInAttendance\", is_default as \"isDefault\", created_at as \"createdAt\" FROM hrms.employment_status_configs WHERE organization_id = $1::uuid ORDER BY created_at ASC",
        organizationId
      );
      return res.status(200).json(statuses);
    } catch (err) {
      next(err);
    }
  });

  router.post("/employment-statuses", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const { name, color, countInAttendance } = req.body || {};
      if (!name || !name.trim()) {
        return res.status(400).json({ message: "Status name is required." });
      }

      const cleanName = name.trim();
      const code = cleanName.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "");

      const existing = await prisma.$queryRawUnsafe(
        "SELECT id FROM hrms.employment_status_configs WHERE organization_id = $1::uuid AND code = $2",
        organizationId,
        code
      );
      if (existing.length > 0) {
        return res.status(400).json({ message: `Status "${cleanName}" already exists.` });
      }

      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO hrms.employment_status_configs (organization_id, name, code, color, count_in_attendance, is_default)
         VALUES ($1::uuid, $2, $3, $4, $5, false)
         RETURNING id, name, code, color, count_in_attendance as "countInAttendance", is_default as "isDefault", created_at as "createdAt"`,
        organizationId,
        cleanName,
        code,
        color || "emerald",
        countInAttendance !== undefined ? Boolean(countInAttendance) : true
      );

      return res.status(201).json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  router.patch("/employment-statuses/:id", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const { name, color, countInAttendance } = req.body || {};

      const existing = await prisma.$queryRawUnsafe(
        "SELECT id, is_default FROM hrms.employment_status_configs WHERE id = $1::uuid AND organization_id = $2::uuid",
        req.params.id,
        organizationId
      );
      if (existing.length === 0) {
        return res.status(404).json({ message: "Status not found." });
      }

      const updates = [];
      const values = [req.params.id, organizationId];
      let pIdx = 3;

      if (name && name.trim()) {
        updates.push(`name = $${pIdx++}`);
        values.push(name.trim());
      }
      if (color) {
        updates.push(`color = $${pIdx++}`);
        values.push(color);
      }
      if (countInAttendance !== undefined) {
        updates.push(`count_in_attendance = $${pIdx++}`);
        values.push(Boolean(countInAttendance));
      }

      if (updates.length === 0) {
        return res.status(200).json(existing[0]);
      }

      const query = `UPDATE hrms.employment_status_configs SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $1::uuid AND organization_id = $2::uuid RETURNING id, name, code, color, count_in_attendance as "countInAttendance", is_default as "isDefault"`;
      const rows = await prisma.$queryRawUnsafe(query, ...values);
      return res.status(200).json(rows[0]);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/employment-statuses/:id", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const existing = await prisma.$queryRawUnsafe(
        "SELECT id, code, is_default FROM hrms.employment_status_configs WHERE id = $1::uuid AND organization_id = $2::uuid",
        req.params.id,
        organizationId
      );
      if (existing.length === 0) {
        return res.status(404).json({ message: "Status not found." });
      }
      if (existing[0].is_default || existing[0].code === "ACTIVE") {
        return res.status(400).json({ message: "Default system status cannot be deleted." });
      }

      // Check if any employees currently have this status
      const assignedUsers = await prisma.user.count({
        where: { organizationId, status: existing[0].code },
      });
      if (assignedUsers > 0) {
        return res.status(400).json({
          message: `Cannot delete status "${existing[0].code}". There are currently ${assignedUsers} employee(s) assigned with this status. Please reassign them first.`,
        });
      }

      await prisma.$executeRawUnsafe(
        "DELETE FROM hrms.employment_status_configs WHERE id = $1::uuid AND organization_id = $2::uuid",
        req.params.id,
        organizationId
      );

      return res.status(200).json({ message: "Status removed successfully." });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createCoreHrRouter };
