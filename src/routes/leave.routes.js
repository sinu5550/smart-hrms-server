const express = require("express");
const { authenticateToken, requireRoles } = require("../middleware");

function createLeaveRouter(prisma) {
  const router = express.Router();
  router.use(authenticateToken);

  // Helper to ensure default leave types exist for the organization
  async function ensureDefaultLeaveTypes(organizationId) {
    const existing = await prisma.leaveType.findMany({ where: { organizationId } });
    if (existing.length === 0) {
      const defaults = [
        { name: "CASUAL", daysAllowed: 10, isPaid: true },
        { name: "SICK", daysAllowed: 14, isPaid: true },
        { name: "ANNUAL", daysAllowed: 15, isPaid: true },
      ];
      for (const d of defaults) {
        await prisma.leaveType.create({
          data: {
            organizationId,
            name: d.name,
            daysAllowed: d.daysAllowed,
            isPaid: d.isPaid,
          },
        }).catch(() => {});
      }
    }
    return prisma.leaveType.findMany({ where: { organizationId } });
  }

  // GET /api/leave/types
  router.get("/types", async (req, res, next) => {
    try {
      const types = await ensureDefaultLeaveTypes(req.user.organizationId);
      return res.status(200).json(types);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/leave (Admin/HR sees all, Dept Head sees department, Employee sees own)
  router.get("/", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const callerUserId = req.user.userId;
      const isManager = req.user.role === "ADMIN" || req.user.role === "HR";

      // Check if user is head of any departments
      const headedDepts = await prisma.department.findMany({
        where: { organizationId, headUserId: callerUserId },
        select: { id: true },
      });
      const headedDeptIds = headedDepts.map((d) => d.id);
      const isDeptHead = headedDeptIds.length > 0;

      let whereClause = {};
      if (isManager) {
        whereClause = { organizationId };
      } else if (isDeptHead) {
        // Dept Head sees their own leaves OR leaves of members in their department
        whereClause = {
          organizationId,
          OR: [
            { userId: callerUserId },
            { user: { departmentId: { in: headedDeptIds } } },
          ],
        };
      } else {
        whereClause = { organizationId, userId: callerUserId };
      }

      const requests = await prisma.leaveRequest.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" },
        include: {
          leaveType: { select: { id: true, name: true, isPaid: true } },
          user: {
            select: {
              id: true,
              fullName: true,
              employeeId: true,
              avatarUrl: true,
              departmentId: true,
              department: { select: { id: true, name: true, headUserId: true } },
            },
          },
        },
      });

      return res.status(200).json(requests);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/leave (Apply for Leave)
  router.post("/", async (req, res, next) => {
    try {
      const { leaveTypeName, startDate, endDate, totalDays, reason } = req.body || {};
      const organizationId = req.user.organizationId;
      const userId = req.user.userId;

      if (!startDate || !endDate || !reason) {
        return res.status(400).json({ message: "Start date, end date, and reason are required." });
      }

      const types = await ensureDefaultLeaveTypes(organizationId);
      const matchedType = types.find((t) => t.name === leaveTypeName) || types[0];

      if (!matchedType) {
        return res.status(400).json({ message: "Invalid leave type." });
      }

      const days = Number(totalDays) || 1;

      const created = await prisma.leaveRequest.create({
        data: {
          organizationId,
          userId,
          leaveTypeId: matchedType.id,
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          totalDays: days,
          reason: reason.trim(),
          status: "PENDING",
        },
        include: {
          leaveType: true,
          user: {
            select: { id: true, fullName: true, employeeId: true },
          },
        },
      });

      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/leave/:id/dept-head-status (Department Head approves or rejects)
  router.patch("/:id/dept-head-status", async (req, res, next) => {
    try {
      const { id } = req.params;
      const { deptHeadStatus, note } = req.body || {};
      const organizationId = req.user.organizationId;
      const callerUserId = req.user.userId;
      const isManager = req.user.role === "ADMIN" || req.user.role === "HR";

      const existing = await prisma.leaveRequest.findFirst({
        where: { id, organizationId },
        include: {
          user: { select: { id: true, departmentId: true } },
        },
      });

      if (!existing) {
        return res.status(404).json({ message: "Leave request not found." });
      }

      // Verify that caller is the Head of the employee's department (or Admin/HR)
      if (!isManager) {
        if (!existing.user?.departmentId) {
          return res.status(403).json({ message: "Employee does not belong to any department." });
        }
        const dept = await prisma.department.findFirst({
          where: { id: existing.user.departmentId, organizationId, headUserId: callerUserId },
        });
        if (!dept) {
          return res.status(403).json({ message: "Only the designated Department Head can review this leave." });
        }
      }

      const updated = await prisma.leaveRequest.update({
        where: { id },
        data: {
          deptHeadStatus: deptHeadStatus === "REJECTED" ? "REJECTED" : "APPROVED",
          deptHeadActionedAt: new Date(),
          deptHeadNote: note || null,
        },
        include: {
          leaveType: true,
          user: {
            select: { id: true, fullName: true, employeeId: true, department: { select: { name: true } } },
          },
        },
      });

      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/leave/:id/status (Admin/HR approves or rejects)
  router.patch("/:id/status", requireRoles("ADMIN", "HR"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { status, rejectionNote } = req.body || {};
      const organizationId = req.user.organizationId;

      const existing = await prisma.leaveRequest.findFirst({
        where: { id, organizationId },
      });

      if (!existing) {
        return res.status(404).json({ message: "Leave request not found." });
      }

      const updated = await prisma.leaveRequest.update({
        where: { id },
        data: {
          status: status || "APPROVED",
          rejectionNote: rejectionNote || null,
          actionedById: req.user.userId,
        },
      });

      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createLeaveRouter };
