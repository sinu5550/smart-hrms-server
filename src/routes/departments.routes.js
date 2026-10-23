const express = require("express");
const { authenticateToken, requireRoles } = require("../middleware");

function createDepartmentsRouter(prisma) {
  const router = express.Router();

  router.use(authenticateToken);

  // GET /api/departments
  router.get("/", async (req, res, next) => {
    try {
      const departments = await prisma.department.findMany({
        where: { organizationId: req.user.organizationId },
        include: {
          _count: {
            select: { users: { where: { isDeleted: false } } },
          },
        },
        orderBy: { name: "asc" },
      });
      return res.status(200).json(departments);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/departments/:id
  router.get("/:id", async (req, res, next) => {
    try {
      const dept = await prisma.department.findFirst({
        where: { id: req.params.id, organizationId: req.user.organizationId },
        include: {
          _count: { select: { users: { where: { isDeleted: false } } } },
        },
      });
      if (!dept) {
        return res.status(404).json({ message: "Department not found." });
      }
      return res.status(200).json(dept);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/departments
  router.post("/", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const dto = req.body || {};
      const organizationId = req.user.organizationId;
      const name = (dto.name || "").trim();
      const code = (dto.code || name.slice(0, 3)).trim().toUpperCase();

      if (!name) {
        return res.status(400).json({ message: "Department name is required." });
      }

      const existingName = await prisma.department.findFirst({
        where: { organizationId, name: { equals: name, mode: "insensitive" } },
      });
      if (existingName) {
        return res.status(409).json({ message: `Department "${name}" already exists.` });
      }

      const existingCode = await prisma.department.findFirst({
        where: { organizationId, code },
      });
      if (existingCode) {
        return res.status(409).json({ message: `Department code "${code}" already exists.` });
      }

      const created = await prisma.department.create({
        data: { name, code, organizationId },
        include: { _count: { select: { users: true } } },
      });

      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/departments/:id
  router.patch("/:id", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const dto = req.body || {};
      const organizationId = req.user.organizationId;

      const dept = await prisma.department.findFirst({ where: { id, organizationId } });
      if (!dept) {
        return res.status(404).json({ message: "Department not found." });
      }

      const data = {};
      if (dto.name) {
        const name = dto.name.trim();
        const existing = await prisma.department.findFirst({
          where: { organizationId, name: { equals: name, mode: "insensitive" }, NOT: { id } },
        });
        if (existing) {
          return res.status(409).json({ message: `Department "${name}" already exists.` });
        }
        data.name = name;
      }

      if (dto.code) {
        const code = dto.code.trim().toUpperCase();
        const existing = await prisma.department.findFirst({
          where: { organizationId, code, NOT: { id } },
        });
        if (existing) {
          return res.status(409).json({ message: `Department code "${code}" already exists.` });
        }
        data.code = code;
      }

      const updated = await prisma.department.update({
        where: { id },
        data,
        include: { _count: { select: { users: true } } },
      });

      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/departments/:id
  router.delete("/:id", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const organizationId = req.user.organizationId;

      const dept = await prisma.department.findFirst({ where: { id, organizationId } });
      if (!dept) {
        return res.status(404).json({ message: "Department not found." });
      }

      await prisma.user.updateMany({
        where: { departmentId: id, organizationId },
        data: { departmentId: null },
      });

      const deleted = await prisma.department.delete({ where: { id } });
      return res.status(200).json(deleted);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createDepartmentsRouter };
