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

  // GET /api/departments/roster-shift-requests (Must be declared before /:id)
  router.get("/roster-shift-requests", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const callerUserId = req.user.userId;

      // Fetch pending requests for departments user is member or manager of
      const requests = await prisma.rosterShiftRequest.findMany({
        where: { organizationId },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              employeeId: true,
              email: true,
              avatarUrl: true,
              department: {
                select: { id: true, name: true },
              },
            },
          },
          targetShift: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return res.status(200).json(requests);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/departments/:id
  router.get("/:id", async (req, res, next) => {
    try {
      const isUUID = (val) =>
        typeof val === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val.trim());

      if (!isUUID(req.params.id)) {
        return res.status(404).json({ message: "Department not found." });
      }

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

  // PATCH /api/departments/:id/employee-shift
  // Allows Admin, HR or Department Head to assign/change an employee's shift within permitted roster department
  router.patch("/:id/employee-shift", async (req, res, next) => {
    try {
      const { id } = req.params;
      const { employeeUserId, shiftId } = req.body || {};
      const organizationId = req.user.organizationId;
      const callerUserId = req.user.userId;
      const userRole = req.user.role;

      const dept = await prisma.department.findFirst({ where: { id, organizationId } });
      if (!dept) {
        return res.status(404).json({ message: "Department not found." });
      }

      // Check permission: Must be ADMIN, HR, or Head of this Department
      const isDeptHead = dept.headUserId === callerUserId;
      const isManager = userRole === "OWNER" || userRole === "ADMIN" || userRole === "HR" || userRole === "PLATFORM_ADMIN" || req.user.isOwner;
      if (!isDeptHead && !isManager) {
        return res.status(403).json({ message: "Only Department Head, HR or Admin can assign employee shifts." });
      }

      const emp = await prisma.user.findFirst({
        where: { id: employeeUserId, organizationId, departmentId: id },
      });
      if (!emp) {
        return res.status(404).json({ message: "Employee not found in this department." });
      }

      if (shiftId) {
        const targetShift = await prisma.officeSetting.findFirst({
          where: { id: shiftId, organizationId },
        });
        if (!targetShift) {
          return res.status(400).json({ message: "Selected shift schedule not found." });
        }
      }

      const updated = await prisma.user.update({
        where: { id: employeeUserId },
        data: {
          shiftId: shiftId || null,
        },
        select: {
          id: true,
          fullName: true,
          employeeId: true,
          shiftId: true,
          shift: {
            select: { id: true, shiftName: true, startTime: true, endTime: true },
          },
        },
      });

      return res.status(200).json({ success: true, employee: updated });
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
      const isManager = userRole === "OWNER" || userRole === "ADMIN" || userRole === "HR" || userRole === "PLATFORM_ADMIN" || req.user.isOwner;
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

  // ==========================================
  // ROSTER SHIFT CHANGE REQUESTS (EMPLOYEE & DEPT HEAD)
  // ==========================================

  // GET /api/departments/roster-shift-requests
  // Returns roster shift change requests:
  // - Employee gets their own requests
  // - Department Head gets requests for their department
  // - Admin/HR gets all organization requests
  router.get("/roster-shift-requests", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const callerUserId = req.user.userId;
      const userRole = req.user.role;
      const isManager = userRole === "OWNER" || userRole === "ADMIN" || userRole === "HR" || userRole === "PLATFORM_ADMIN" || req.user.isOwner;

      const headedDepts = await prisma.department.findMany({
        where: { organizationId, headUserId: callerUserId },
        select: { id: true },
      });
      const headedDeptIds = headedDepts.map((d) => d.id);
      const isDeptHead = headedDeptIds.length > 0;

      let whereClause = { organizationId };

      if (isManager) {
        // Can filter by status if provided in query
      } else if (isDeptHead) {
        whereClause = {
          organizationId,
          OR: [
            { userId: callerUserId },
            { user: { departmentId: { in: headedDeptIds } } },
          ],
        };
      } else {
        whereClause = {
          organizationId,
          userId: callerUserId,
        };
      }

      if (req.query.status) {
        whereClause.status = req.query.status;
      }

      const requests = await prisma.rosterShiftRequest.findMany({
        where: whereClause,
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              employeeId: true,
              email: true,
              avatarUrl: true,
              departmentId: true,
              department: { select: { id: true, name: true, headUserId: true } },
              shift: { select: { id: true, shiftName: true, startTime: true, endTime: true } },
            },
          },
          targetShift: {
            select: { id: true, shiftName: true, startTime: true, endTime: true },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return res.status(200).json(requests);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/departments/roster-shift-requests
  // Allows an employee (specifically Roster employees) to submit a shift change request for next day / upcoming date
  router.post("/roster-shift-requests", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const callerUserId = req.user.userId;
      const { targetShiftId, effectiveDate, reason } = req.body || {};

      if (!targetShiftId) {
        return res.status(400).json({ message: "Please select the target shift you wish to switch to." });
      }

      // Check if user is a roster employee
      const user = await prisma.user.findFirst({
        where: { id: callerUserId, organizationId },
        include: {
          department: true,
          organization: { select: { hasRosterDuty: true, rosterDepartmentIds: true } },
        },
      });

      if (!user) {
        return res.status(404).json({ message: "User not found." });
      }

      const orgHasRoster = Boolean(user.organization?.hasRosterDuty);
      const rosterDeptIds = Array.isArray(user.organization?.rosterDepartmentIds) ? user.organization.rosterDepartmentIds : [];
      const isRosterEmp = orgHasRoster && user.departmentId && rosterDeptIds.includes(user.departmentId);

      if (!isRosterEmp) {
        return res.status(403).json({ message: "Roster shift change applications are only available for designated roster employees." });
      }

      const shiftExists = await prisma.officeSetting.findFirst({
        where: { id: targetShiftId, organizationId },
      });
      if (!shiftExists) {
        return res.status(400).json({ message: "Selected shift not found." });
      }

      // Default to tomorrow's date if not specified
      let effDate = new Date();
      effDate.setDate(effDate.getDate() + 1);
      if (effectiveDate) {
        effDate = new Date(effectiveDate);
      }
      const effUtc = new Date(Date.UTC(effDate.getUTCFullYear(), effDate.getUTCMonth(), effDate.getUTCDate()));

      const created = await prisma.rosterShiftRequest.create({
        data: {
          organizationId,
          userId: callerUserId,
          targetShiftId,
          effectiveDate: effUtc,
          reason: (reason || "").trim() || "Shift change requested by employee",
          status: "PENDING",
        },
        include: {
          targetShift: { select: { id: true, shiftName: true, startTime: true, endTime: true } },
        },
      });

      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/departments/roster-shift-requests/:id/action
  // Allows Department Head (or Admin/HR) to Accept or Reject
  // If Accepted: Automatically updates user's shiftId to targetShiftId!
  router.patch("/roster-shift-requests/:id/action", async (req, res, next) => {
    try {
      const { id } = req.params;
      const { action, actionNote } = req.body || {}; // action: "APPROVED" | "REJECTED"
      const organizationId = req.user.organizationId;
      const callerUserId = req.user.userId;
      const userRole = req.user.role;
      const isManager = userRole === "OWNER" || userRole === "ADMIN" || userRole === "HR" || userRole === "PLATFORM_ADMIN" || req.user.isOwner;

      const request = await prisma.rosterShiftRequest.findFirst({
        where: { id, organizationId },
        include: {
          user: { select: { id: true, departmentId: true, fullName: true, employeeId: true } },
          targetShift: true,
        },
      });

      if (!request) {
        return res.status(404).json({ message: "Roster shift change request not found." });
      }

      // Check permission: Must be Department Head of that employee's department or Admin/HR
      if (!isManager) {
        if (!request.user?.departmentId) {
          return res.status(403).json({ message: "Employee has no assigned department." });
        }
        const dept = await prisma.department.findFirst({
          where: { id: request.user.departmentId, organizationId, headUserId: callerUserId },
        });
        if (!dept) {
          return res.status(403).json({ message: "Only the designated Department Head can accept or reject this request." });
        }
      }

      const newStatus = action === "APPROVED" || action === "ACCEPT" ? "APPROVED" : "REJECTED";

      // If approved, automatically update the employee's shift in User table!
      if (newStatus === "APPROVED") {
        await prisma.user.update({
          where: { id: request.userId },
          data: {
            shiftId: request.targetShiftId,
          },
        });
      }

      const updated = await prisma.rosterShiftRequest.update({
        where: { id },
        data: {
          status: newStatus,
          actionedById: callerUserId,
          actionedAt: new Date(),
          actionNote: actionNote || null,
        },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              employeeId: true,
              shift: { select: { id: true, shiftName: true, startTime: true, endTime: true } },
            },
          },
          targetShift: {
            select: { id: true, shiftName: true, startTime: true, endTime: true },
          },
        },
      });

      return res.status(200).json({
        success: true,
        message: newStatus === "APPROVED" ? "Roster shift request approved and employee shift updated successfully." : "Roster shift request rejected.",
        request: updated,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createDepartmentsRouter };
