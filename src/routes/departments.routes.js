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
          headUser: {
            select: { id: true, fullName: true, employeeId: true, email: true, avatarUrl: true },
          },
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
          headUser: {
            select: { id: true, fullName: true, employeeId: true, email: true, avatarUrl: true },
          },
          users: {
            where: { isDeleted: false },
            select: {
              id: true,
              fullName: true,
              employeeId: true,
              email: true,
              avatarUrl: true,
              role: true,
              status: true,
              rosterOffDays: true,
              designation: { select: { id: true, name: true } },
              shift: { select: { id: true, shiftName: true, startTime: true, endTime: true } },
            },
            orderBy: { fullName: "asc" },
          },
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

      if (dto.headUserId !== undefined) {
        data.headUserId = dto.headUserId ? dto.headUserId : null;
      }

      const updated = await prisma.department.update({
        where: { id },
        data,
        include: {
          headUser: { select: { id: true, fullName: true, employeeId: true, email: true, avatarUrl: true } },
          _count: { select: { users: true } },
        },
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

  // PATCH /api/departments/:id/employee-roster-offdays
  // Allows Admin, HR or Department Head to configure specific weekly off-days for an employee in this department
  router.patch("/:id/employee-roster-offdays", async (req, res, next) => {
    try {
      const { id } = req.params;
      const { employeeUserId, rosterOffDays } = req.body || {};
      const organizationId = req.user.organizationId;
      const callerUserId = req.user.userId;
      const userRole = req.user.role;

      const dept = await prisma.department.findFirst({ where: { id, organizationId } });
      if (!dept) {
        return res.status(404).json({ message: "Department not found." });
      }

      // Check permission: Must be ADMIN, HR, or Head of this Department
      const isDeptHead = dept.headUserId === callerUserId;
      const isManager = userRole === "ADMIN" || userRole === "HR";
      if (!isDeptHead && !isManager) {
        return res.status(403).json({ message: "Only Department Head, HR or Admin can assign roster off-days." });
      }

      const emp = await prisma.user.findFirst({
        where: { id: employeeUserId, organizationId, departmentId: id },
      });
      if (!emp) {
        return res.status(404).json({ message: "Employee not found in this department." });
      }

      const updated = await prisma.user.update({
        where: { id: employeeUserId },
        data: {
          rosterOffDays: Array.isArray(rosterOffDays) ? rosterOffDays : [],
        },
        select: {
          id: true,
          fullName: true,
          employeeId: true,
          rosterOffDays: true,
        },
      });

      return res.status(200).json({ success: true, employee: updated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createDepartmentsRouter };
