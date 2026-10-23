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
          organizationId,
          isDefault: dto.isDefault ?? count === 0,
        },
      });

      return res.status(201).json(created);
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

      const updated = await prisma.officeSetting.update({
        where: { id },
        data: dto,
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
