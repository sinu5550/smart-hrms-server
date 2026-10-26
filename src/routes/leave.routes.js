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

  // GET /api/leave (Admin/HR sees all, Employee sees own)
  router.get("/", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const isManager = req.user.role === "ADMIN" || req.user.role === "HR";

      const whereClause = isManager
        ? { organizationId }
        : { organizationId, userId: req.user.userId };

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
              department: { select: { name: true } },
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
