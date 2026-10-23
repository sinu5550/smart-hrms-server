const express = require("express");
const { authenticateToken, requireRoles } = require("../middleware");

function createOutworkRouter(prisma) {
  const router = express.Router();
  router.use(authenticateToken);

  // GET /api/outwork (Admin/HR sees all in org, Employee sees own)
  router.get("/", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const isManager = req.user.role === "ADMIN" || req.user.role === "HR";

      const whereClause = isManager
        ? { organizationId }
        : { organizationId, userId: req.user.userId };

      const requests = await prisma.outworkRequest.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" },
      });

      return res.status(200).json(requests);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/outwork (Employee applies for field visit / client visit)
  router.post("/", async (req, res, next) => {
    try {
      const { visitDate, destination, purpose, latitude, longitude } = req.body || {};
      const organizationId = req.user.organizationId;

      if (!destination || !purpose) {
        return res.status(400).json({ message: "Destination and purpose are required." });
      }

      const dateObj = visitDate ? new Date(visitDate) : new Date();

      const created = await prisma.outworkRequest.create({
        data: {
          organizationId,
          userId: req.user.userId,
          visitDate: dateObj,
          destination: destination.trim(),
          purpose: purpose.trim(),
          latitude: latitude ? Number(latitude) : null,
          longitude: longitude ? Number(longitude) : null,
          status: "PENDING",
        },
      });

      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/outwork/:id/status (Admin/HR approves or rejects)
  router.patch("/:id/status", requireRoles("ADMIN", "HR"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { status, approvalNotes } = req.body || {};
      const organizationId = req.user.organizationId;

      const existing = await prisma.outworkRequest.findFirst({
        where: { id, organizationId },
      });

      if (!existing) {
        return res.status(404).json({ message: "Outwork request not found." });
      }

      const updated = await prisma.outworkRequest.update({
        where: { id },
        data: {
          status: status || "APPROVED",
          approvalNotes: approvalNotes || null,
          approvedBy: req.user.userId,
        },
      });

      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createOutworkRouter };
