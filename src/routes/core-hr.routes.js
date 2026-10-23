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

  return router;
}

module.exports = { createCoreHrRouter };
