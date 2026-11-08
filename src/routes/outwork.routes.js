const express = require("express");
const { authenticateToken, requireRoles, resolveClientIp } = require("../middleware");

// Helper to determine the organization's attendance date based on dayCutoffHour (Asia/Dhaka)
async function getOrganizationAttendanceDate(prisma, organizationId, dateInput = new Date()) {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { dayCutoffHour: true },
  });
  const cutoffHour = org?.dayCutoffHour ?? 6;

  const inputDate = new Date(dateInput);
  const shifted = new Date(inputDate.getTime() - cutoffHour * 3600 * 1000);
  const localYMD = shifted.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
  const [y, m, d] = localYMD.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

// Helper to calculate shift status (PRESENT vs LATE)
async function calculateShiftStatus(prisma, organizationId, userId, checkInDate) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { shiftId: true },
    });

    let setting = user?.shiftId
      ? await prisma.officeSetting.findUnique({ where: { id: user.shiftId } })
      : null;

    if (!setting) {
      setting = await prisma.officeSetting.findFirst({
        where: { organizationId, isDefault: true },
      });
    }

    const startTimeStr = setting?.startTime || "09:00";
    const graceMinutes = setting?.gracePeriodMinutes ?? 30;
    const [startHour, startMinute] = startTimeStr.split(":").map(Number);

    const cutoffTotalMinutes = startHour * 60 + startMinute + graceMinutes;
    const bdTimeStr = checkInDate.toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour12: false });
    const [curHour, curMinute] = bdTimeStr.split(":").map(Number);
    const checkInMinutes = curHour * 60 + curMinute;

    return checkInMinutes > cutoffTotalMinutes ? "LATE" : "PRESENT";
  } catch {
    return "PRESENT";
  }
}

function createOutworkRouter(prisma) {
  const router = express.Router();
  router.use(authenticateToken);

  // GET /api/outwork (Admin/HR/Owner sees all in org, Employee sees own)
  router.get("/", async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const callerUserId = req.user.userId;
      const userRole = req.user.role;

      // Verify roles & permissions from database
      const callerUser = await prisma.user.findUnique({
        where: { id: callerUserId },
        select: {
          role: true,
          email: true,
          permissions: true,
          department: { select: { name: true } },
          organization: { select: { ownerEmail: true } },
        },
      });

      const permissions = Array.isArray(callerUser?.permissions) ? callerUser.permissions : [];
      const isOwner = Boolean(
        userRole === "OWNER" ||
        userRole === "PLATFORM_ADMIN" ||
        callerUser?.role === "OWNER" ||
        (callerUser?.organization?.ownerEmail && callerUser?.email?.toLowerCase() === callerUser?.organization?.ownerEmail?.toLowerCase()) ||
        req.user.isOwner
      );
      const isAdminOrHr = Boolean(
        userRole === "ADMIN" ||
        userRole === "HR" ||
        callerUser?.role === "ADMIN" ||
        callerUser?.role === "HR" ||
        callerUser?.department?.name === "HR & Admin"
      );
      const hasOutworkPerm = Boolean(
        permissions.includes("attendance.view") ||
        permissions.includes("attendance.manage") ||
        permissions.includes("reports.export") ||
        permissions.includes("employees.view")
      );

      const isManager = isOwner || isAdminOrHr || hasOutworkPerm;

      const whereClause = isManager
        ? { organizationId }
        : { organizationId, userId: callerUserId };

      const requests = await prisma.outworkRequest.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" },
      });

      const userIds = [...new Set(requests.map((r) => r.userId).filter(Boolean))];
      const users = userIds.length
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: {
              id: true,
              fullName: true,
              employeeId: true,
              email: true,
              avatarUrl: true,
              department: { select: { name: true } },
            },
          })
        : [];
      const userMap = new Map(users.map((u) => [u.id, u]));

      const enriched = requests.map((r) => ({
        ...r,
        user: userMap.get(r.userId) || { fullName: "Employee", employeeId: "N/A" },
      }));

      return res.status(200).json(enriched);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/outwork (Employee applies for field visit / client visit)
  // When employee applies for out of work, their attendance check-in is logged immediately
  // with checkInTime = exact submission timestamp.
  router.post("/", async (req, res, next) => {
    try {
      const { visitDate, destination, purpose, latitude, longitude } = req.body || {};
      const organizationId = req.user.organizationId;

      if (!destination || !purpose) {
        return res.status(400).json({ message: "Destination and purpose are required." });
      }

      const now = new Date();
      const dateObj = visitDate ? new Date(visitDate) : now;

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

      // =========================================================================
      // IMMEDIATE ATTENDANCE CHECK-IN AT OUTWORK SUBMISSION TIME
      // =========================================================================
      let attendanceRecord = null;
      try {
        const attendanceDate = await getOrganizationAttendanceDate(prisma, organizationId, now);
        const existingAttendance = await prisma.attendance.findUnique({
          where: {
            userId_date: {
              userId: req.user.userId,
              date: attendanceDate,
            },
          },
        });

        if (!existingAttendance) {
          const ipAddress = resolveClientIp(req);
          const shiftStatus = await calculateShiftStatus(prisma, organizationId, req.user.userId, now);

          attendanceRecord = await prisma.attendance.create({
            data: {
              organizationId,
              userId: req.user.userId,
              date: attendanceDate,
              checkInTime: now, // EXACT SUBMISSION TIMESTAMP
              currentState: "CHECKED_IN",
              status: shiftStatus,
              ipAddress: ipAddress || "127.0.0.1",
              punchInLatitude: latitude ? Number(latitude) : null,
              punchInLongitude: longitude ? Number(longitude) : null,
              punchInAddress: destination.trim(),
              punchInDeviceType: "OUTWORK",
            },
          });
        } else {
          // If already checked in earlier, preserve their existing checkInTime
          // If they were marked absent or hadn't checked in yet, activate their check-in with `now`
          if (!existingAttendance.checkInTime || existingAttendance.status === "ABSENT") {
            const shiftStatus = await calculateShiftStatus(prisma, organizationId, req.user.userId, now);
            attendanceRecord = await prisma.attendance.update({
              where: { id: existingAttendance.id },
              data: {
                checkInTime: now,
                currentState: "CHECKED_IN",
                status: shiftStatus,
                punchInDeviceType: "OUTWORK",
                punchInAddress: destination.trim(),
              },
            });
          } else {
            attendanceRecord = existingAttendance;
          }
        }
      } catch (attErr) {
        console.error("Outwork auto-checkin non-fatal error:", attErr);
      }

      return res.status(201).json({
        ...created,
        checkedIn: true,
        checkInTime: attendanceRecord?.checkInTime || now,
      });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/outwork/:id/status (Admin/HR/Owner approves or rejects)
  // When Admin/HR approves, the check-in time MUST strictly remain the original
  // application submission timestamp (existing.createdAt), NOT the approval timestamp!
  router.patch("/:id/status", async (req, res, next) => {
    try {
      const { id } = req.params;
      const { status, approvalNotes } = req.body || {};
      const organizationId = req.user.organizationId;
      const callerUserId = req.user.userId;
      const userRole = req.user.role;

      const callerUser = await prisma.user.findUnique({
        where: { id: callerUserId },
        select: {
          role: true,
          email: true,
          permissions: true,
          department: { select: { name: true } },
          organization: { select: { ownerEmail: true } },
        },
      });

      const permissions = Array.isArray(callerUser?.permissions) ? callerUser.permissions : [];
      const isOwner = Boolean(
        userRole === "OWNER" ||
        userRole === "PLATFORM_ADMIN" ||
        callerUser?.role === "OWNER" ||
        (callerUser?.organization?.ownerEmail && callerUser?.email?.toLowerCase() === callerUser?.organization?.ownerEmail?.toLowerCase()) ||
        req.user.isOwner
      );
      const isAdminOrHr = Boolean(
        userRole === "ADMIN" ||
        userRole === "HR" ||
        callerUser?.role === "ADMIN" ||
        callerUser?.role === "HR" ||
        callerUser?.department?.name === "HR & Admin"
      );
      const canManage = isOwner || isAdminOrHr || permissions.includes("attendance.manage");

      if (!canManage) {
        return res.status(403).json({ message: "Only HR, Admin or Owner can sanction outwork applications." });
      }

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

      // =========================================================================
      // PRESERVE ORIGINAL APPLICATION SUBMISSION TIME ON APPROVAL
      // Never set checkInTime to current approval time!
      // =========================================================================
      if (status === "APPROVED" || !status) {
        try {
          const applyTime = existing.createdAt;
          const attendanceDate = await getOrganizationAttendanceDate(prisma, organizationId, applyTime);

          const existingAttendance = await prisma.attendance.findUnique({
            where: {
              userId_date: {
                userId: existing.userId,
                date: attendanceDate,
              },
            },
          });

          if (!existingAttendance) {
            // Created with applyTime, NEVER approval time
            await prisma.attendance.create({
              data: {
                organizationId,
                userId: existing.userId,
                date: attendanceDate,
                checkInTime: applyTime, // STRICTLY THE ORIGINAL SUBMISSION TIME
                currentState: "CHECKED_IN",
                status: "PRESENT",
                ipAddress: "127.0.0.1",
                punchInLatitude: existing.latitude,
                punchInLongitude: existing.longitude,
                punchInAddress: existing.destination,
                punchInDeviceType: "OUTWORK",
              },
            });
          } else {
            // Retain original checkInTime (or applyTime), ensure status is marked PRESENT upon approval
            const finalCheckInTime = existingAttendance.checkInTime || applyTime;
            await prisma.attendance.update({
              where: { id: existingAttendance.id },
              data: {
                status: "PRESENT",
                checkInTime: finalCheckInTime,
              },
            });
          }
        } catch (attErr) {
          console.error("Outwork approval attendance sync error:", attErr);
        }
      }

      return res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createOutworkRouter };
