const express = require("express");
const { authenticateToken, requireRoles } = require("../middleware");

function createSettingsRouter(prisma) {
  const router = express.Router();

  router.use(authenticateToken);

  // GET /api/shifts
  router.get("/", async (req, res, next) => {
    try {
      const shifts = await prisma.officeSetting.findMany({
        where: { organizationId: req.user.organizationId },
        include: {
          _count: {
            select: { users: true },
          },
        },
        orderBy: { updatedAt: "asc" },
      });
      return res.status(200).json(shifts);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/shifts/default
  router.get("/default", async (req, res, next) => {
    try {
      const shift = await prisma.officeSetting.findFirst({
        where: { organizationId: req.user.organizationId, isDefault: true },
      });
      if (!shift) {
        const fallback = await prisma.officeSetting.findFirst({
          where: { organizationId: req.user.organizationId },
        });
        return res.status(200).json(fallback);
      }
      return res.status(200).json(shift);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/shifts
  router.post("/", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const dto = req.body || {};
      const organizationId = req.user.organizationId;

      if (dto.isDefault) {
        await prisma.officeSetting.updateMany({
          where: { organizationId },
          data: { isDefault: false },
        });
      }

      const count = await prisma.officeSetting.count({ where: { organizationId } });
      const created = await prisma.officeSetting.create({
        data: {
          ...dto,
          gracePeriodMinutes: dto.gracePeriodMinutes !== undefined ? Number(dto.gracePeriodMinutes) : 30,
          overtimeThresholdMins: dto.overtimeThresholdMins !== undefined ? Number(dto.overtimeThresholdMins) : 30,
          organizationId,
          isDefault: dto.isDefault ?? count === 0,
        },
      });

      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/shifts/shift or /api/settings/shift compatibility
  router.get("/shift", async (req, res, next) => {
    try {
      const shift = await prisma.officeSetting.findFirst({
        where: { organizationId: req.user.organizationId, isDefault: true },
      });
      if (!shift) {
        const fallback = await prisma.officeSetting.findFirst({
          where: { organizationId: req.user.organizationId },
        });
        return res.status(200).json(fallback);
      }
      return res.status(200).json(shift);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/shifts/shift (Update default shift directly)
  router.patch("/shift", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const dto = req.body || {};
      const organizationId = req.user.organizationId;

      let targetShift = await prisma.officeSetting.findFirst({
        where: { organizationId, isDefault: true },
      });

      if (!targetShift) {
        targetShift = await prisma.officeSetting.findFirst({
          where: { organizationId },
        });
      }

      const updateData = { ...dto };
      if (dto.gracePeriodMinutes !== undefined) updateData.gracePeriodMinutes = Number(dto.gracePeriodMinutes);
      if (dto.overtimeThresholdMins !== undefined) updateData.overtimeThresholdMins = Number(dto.overtimeThresholdMins);

      let result;
      if (targetShift) {
        result = await prisma.officeSetting.update({
          where: { id: targetShift.id },
          data: updateData,
        });
      } else {
        result = await prisma.officeSetting.create({
          data: {
            ...updateData,
            organizationId,
            isDefault: true,
          },
        });
      }

      return res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/shifts/:id
  router.patch("/:id", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const dto = req.body || {};
      const organizationId = req.user.organizationId;

      if (dto.isDefault) {
        await prisma.officeSetting.updateMany({
          where: { organizationId },
          data: { isDefault: false },
        });
      }

      const updateData = { ...dto };
      if (dto.gracePeriodMinutes !== undefined) updateData.gracePeriodMinutes = Number(dto.gracePeriodMinutes);
      if (dto.overtimeThresholdMins !== undefined) updateData.overtimeThresholdMins = Number(dto.overtimeThresholdMins);

      const updated = await prisma.officeSetting.update({
        where: { id },
        data: updateData,
      });

      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/shifts/:id
  router.delete("/:id", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const organizationId = req.user.organizationId;

      const shift = await prisma.officeSetting.findFirst({ where: { id, organizationId } });
      if (!shift) return res.status(200).json({ message: "Not found or already deleted" });

      const deleted = await prisma.officeSetting.delete({ where: { id } });
      return res.status(200).json(deleted);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createSettingsRouter };
