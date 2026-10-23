const express = require("express");
const { authenticateToken, requireRoles } = require("../middleware");

function createRolesRouter(prisma) {
  const router = express.Router();

  router.use(authenticateToken);
  router.use(requireRoles("ADMIN", "HR"));

  // GET /api/roles
  router.get("/", async (req, res, next) => {
    try {
      const roles = await prisma.customRole.findMany({
        where: { organizationId: req.user.organizationId },
        include: {
          _count: {
            select: { users: true },
          },
        },
        orderBy: { createdAt: "asc" },
      });
      return res.status(200).json(roles);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/roles/:id
  router.get("/:id", async (req, res, next) => {
    try {
      const role = await prisma.customRole.findFirst({
        where: { id: req.params.id, organizationId: req.user.organizationId },
        include: {
          _count: {
            select: { users: true },
          },
        },
      });
      if (!role) {
        return res.status(404).json({ message: "Role not found." });
      }
      return res.status(200).json(role);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/roles
  router.post("/", async (req, res, next) => {
    try {
      const dto = req.body || {};
      const organizationId = req.user.organizationId;
      const name = (dto.name || "").trim();

      if (!name) {
        return res.status(400).json({ message: "Role name is required." });
      }

      const existing = await prisma.customRole.findFirst({
        where: {
          organizationId,
          name: { equals: name, mode: "insensitive" },
        },
      });

      if (existing) {
        return res.status(400).json({
          message: `Role "${name}" already exists in this workspace.`,
        });
      }

      const created = await prisma.customRole.create({
        data: {
          organizationId,
          name,
          description: dto.description || null,
          permissions: dto.permissions || [],
          isSystem: false,
        },
        include: {
          _count: { select: { users: true } },
        },
      });

      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/roles/:id
  router.patch("/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      const dto = req.body || {};
      const organizationId = req.user.organizationId;

      const role = await prisma.customRole.findFirst({
        where: { id, organizationId },
      });
      if (!role) {
        return res.status(404).json({ message: "Role not found." });
      }

      if (dto.name && dto.name !== role.name) {
        const existing = await prisma.customRole.findFirst({
          where: {
            organizationId,
            name: { equals: dto.name, mode: "insensitive" },
            id: { not: id },
          },
        });
        if (existing) {
          return res.status(400).json({ message: `Another role named "${dto.name}" already exists.` });
        }
      }

      const updatedRole = await prisma.customRole.update({
        where: { id },
        data: {
          ...(dto.name ? { name: dto.name } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.permissions !== undefined ? { permissions: dto.permissions } : {}),
        },
        include: {
          _count: { select: { users: true } },
        },
      });

      // Sync permissions to all assigned users
      if (dto.permissions !== undefined) {
        await prisma.user.updateMany({
          where: { customRoleId: id, organizationId },
          data: {
            permissions: dto.permissions,
          },
        });
      }

      return res.status(200).json(updatedRole);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/roles/:id
  router.delete("/:id", async (req, res, next) => {
    try {
      const { id } = req.params;
      const organizationId = req.user.organizationId;

      const role = await prisma.customRole.findFirst({
        where: { id, organizationId },
      });
      if (!role) {
        return res.status(404).json({ message: "Role not found." });
      }

      if (role.isSystem) {
        return res.status(400).json({ message: "System roles cannot be deleted." });
      }

      const assignedUsers = await prisma.user.count({
        where: { customRoleId: id },
      });

      if (assignedUsers > 0) {
        return res.status(400).json({
          message: `Cannot delete role "${role.name}" because ${assignedUsers} employee(s) are currently assigned to it.`,
        });
      }

      const deleted = await prisma.customRole.delete({
        where: { id },
      });

      return res.status(200).json(deleted);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createRolesRouter };
