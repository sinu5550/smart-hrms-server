const express = require("express");
const { authenticateToken, requireRoles } = require("../middleware");

function createDesignationsRouter(prisma) {
  const router = express.Router();

  router.use(authenticateToken);

  // Helper to verify manager access (OWNER, ADMIN, HR, or permissions)
  const canManageDesignations = (req) => {
    const role = req.user?.role;
    if (role === "OWNER" || role === "ADMIN" || role === "HR" || role === "PLATFORM_ADMIN" || req.user?.isOwner) {
      return true;
    }
    const perms = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
    return perms.includes("designations.manage") || perms.includes("organization.settings") || perms.includes("departments.manage");
  };

  // GET /api/designations - List all designations for the organization
  router.get("/", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      if (!organizationId) {
        return res.status(400).json({ message: "Organization ID is missing." });
      }

      const designations = await prisma.designation.findMany({
        where: { organizationId },
        include: {
          _count: {
            select: {
              users: {
                where: {
                  isDeleted: false,
                },
              },
            },
          },
        },
        orderBy: { name: "asc" },
      });

      return res.status(200).json(designations);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/designations - Create new designation
  router.post("/", async (req, res, next) => {
    try {
      if (!canManageDesignations(req)) {
        return res.status(403).json({ message: "You do not have permission to manage designations." });
      }

      const dto = req.body || {};
      const organizationId = req.user.organizationId;
      const name = (dto.name || "").trim();

      if (!name) {
        return res.status(400).json({ message: "Designation title/name is required." });
      }

      // Generate code if not provided (e.g. "Software Engineer" -> "SE", or first 3-4 chars)
      let code = (dto.code || "").trim().toUpperCase();
      if (!code) {
        const words = name.split(/\s+/).filter(Boolean);
        if (words.length > 1) {
          code = words.map((w) => w[0]).join("").slice(0, 5).toUpperCase();
        } else {
          code = name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase();
        }
      }

      // Check name uniqueness (case-insensitive)
      const existingName = await prisma.designation.findFirst({
        where: { organizationId, name: { equals: name, mode: "insensitive" } },
      });
      if (existingName) {
        return res.status(409).json({ message: `Designation "${name}" already exists.` });
      }

      // Check code uniqueness
      const existingCode = await prisma.designation.findFirst({
        where: { organizationId, code },
      });
      if (existingCode) {
        // If code collided, append random 2 digits
        code = `${code.slice(0, 3)}${Math.floor(10 + Math.random() * 90)}`;
      }

      const created = await prisma.designation.create({
        data: {
          organizationId,
          name,
          code,
        },
        include: {
          _count: {
            select: {
              users: {
                where: {
                  isDeleted: false,
                },
              },
            },
          },
        },
      });

      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/designations/:id - Update designation
  router.patch("/:id", async (req, res, next) => {
    try {
      if (!canManageDesignations(req)) {
        return res.status(403).json({ message: "You do not have permission to manage designations." });
      }

      const { id } = req.params;
      const dto = req.body || {};
      const organizationId = req.user.organizationId;

      const existing = await prisma.designation.findFirst({
        where: { id, organizationId },
      });
      if (!existing) {
        return res.status(404).json({ message: "Designation not found." });
      }

      const data = {};

      if (dto.name !== undefined) {
        const name = dto.name.trim();
        if (!name) {
          return res.status(400).json({ message: "Designation name cannot be empty." });
        }
        const nameConflict = await prisma.designation.findFirst({
          where: { organizationId, name: { equals: name, mode: "insensitive" }, NOT: { id } },
        });
        if (nameConflict) {
          return res.status(409).json({ message: `Designation "${name}" already exists.` });
        }
        data.name = name;
      }

      if (dto.code !== undefined) {
        const code = dto.code.trim().toUpperCase();
        if (!code) {
          return res.status(400).json({ message: "Designation code cannot be empty." });
        }
        const codeConflict = await prisma.designation.findFirst({
          where: { organizationId, code, NOT: { id } },
        });
        if (codeConflict) {
          return res.status(409).json({ message: `Designation code "${code}" already exists.` });
        }
        data.code = code;
      }

      const updated = await prisma.designation.update({
        where: { id },
        data,
        include: {
          _count: {
            select: {
              users: {
                where: {
                  isDeleted: false,
                },
              },
            },
          },
        },
      });

      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/designations/:id - Delete designation
  router.delete("/:id", async (req, res, next) => {
    try {
      if (!canManageDesignations(req)) {
        return res.status(403).json({ message: "You do not have permission to delete designations." });
      }

      const { id } = req.params;
      const organizationId = req.user.organizationId;

      const existing = await prisma.designation.findFirst({
        where: { id, organizationId },
      });
      if (!existing) {
        return res.status(404).json({ message: "Designation not found." });
      }

      // Unlink designation from any employees before deletion
      await prisma.user.updateMany({
        where: { designationId: id, organizationId },
        data: { designationId: null },
      });

      const deleted = await prisma.designation.delete({
        where: { id },
      });

      return res.status(200).json(deleted);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createDesignationsRouter };

