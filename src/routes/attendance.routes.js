const express = require("express");
const crypto = require("crypto");
const { authenticateToken, requireRoles, officeIpGuard, resolveClientIp } = require("../middleware");

function createAttendanceRouter(prisma) {
  const router = express.Router();

  function getUtcMidnightToday() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  async function calculateShiftStatus(organizationId, userId, checkInDate) {
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
    const checkInTotalMinutes = checkInDate.getHours() * 60 + checkInDate.getMinutes();

    if (checkInTotalMinutes > cutoffTotalMinutes) {
      return "LATE";
    }
    return "PRESENT";
  }

  // All attendance endpoints require authentication
  router.use(authenticateToken);

  // GET /api/attendance/today-status
  router.get("/today-status", async (req, res, next) => {
    try {
      const today = getUtcMidnightToday();
      const attendance = await prisma.attendance.findUnique({
        where: { userId_date: { userId: req.user.userId, date: today } },
        include: {
          breaks: {
            orderBy: { startTime: "desc" },
          },
        },
      });

      if (!attendance) {
        return res.status(200).json({
          checkedIn: false,
          checkedOut: false,
          attendance: null,
        });
      }

      return res.status(200).json({
        checkedIn: true,
        checkedOut: attendance.currentState === "CHECKED_OUT",
        attendance,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/attendance/check-in
  router.post(
    "/check-in",
    (req, res, next) => officeIpGuard(prisma, req, res, next),
    async (req, res, next) => {
      try {
        const dto = req.body || {};
        const incomingSecret = (dto.qrSecret || "").trim();
        const validStaticSecret = process.env.OFFICE_QR_SECRET;

        let isQrValid = false;

        // 1. Check if it's the static office token
        if (incomingSecret && incomingSecret === validStaticSecret) {
          isQrValid = true;
        }

        // 2. Check if it's a dynamic JSON tenant QR code
        if (!isQrValid && incomingSecret) {
          try {
            const parsed = JSON.parse(incomingSecret);
            if (parsed && parsed.type === "OFFICE_ATTENDANCE_QR") {
              // Ensure this QR belongs to the user's organization
              if (parsed.orgId && parsed.orgId === req.user.organizationId) {
                const secret = process.env.JWT_SECRET || "hrms_secret";
                const rawData = `tenant:${parsed.orgId}:slug:${parsed.slug || ""}:ip:${parsed.officeIp || "any"}`;
                const expectedSig = crypto.createHmac("sha256", secret).update(rawData).digest("hex");
                if (expectedSig === parsed.sig) {
                  isQrValid = true;
                }
              }
            }
          } catch {
            // Not a JSON string, fallback checked above
          }
        }

        if (!isQrValid) {
          return res.status(403).json({
            message: "Invalid or expired office QR code signature. Ensure you are scanning your organization's designated QR code.",
          });
        }

        const today = getUtcMidnightToday();
        const now = new Date();

        const existingRecord = await prisma.attendance.findUnique({
          where: { userId_date: { userId: req.user.userId, date: today } },
        });

        if (existingRecord) {
          return res.status(409).json({ message: "Attendance check-in already recorded for today." });
        }

        const ipAddress = resolveClientIp(req);
        const status = await calculateShiftStatus(req.user.organizationId, req.user.userId, now);

        const record = await prisma.attendance.create({
          data: {
            organizationId: req.user.organizationId,
            userId: req.user.userId,
            date: today,
            checkInTime: now,
            currentState: "CHECKED_IN",
            status,
            ipAddress,
            punchInLatitude: dto.latitude || null,
            punchInLongitude: dto.longitude || null,
            punchInAddress: dto.address || null,
            punchInDeviceType: dto.deviceType || "MOBILE_PWA",
            punchInSelfieUrl: dto.selfieUrl || null,
          },
          include: {
            breaks: true,
          },
        });

        return res.status(200).json(record);
      } catch (err) {
        next(err);
      }
    }
  );

  // POST /api/attendance/break-start
  router.post(
    "/break-start",
    (req, res, next) => officeIpGuard(prisma, req, res, next),
    async (req, res, next) => {
      try {
        const dto = req.body || {};
        const today = getUtcMidnightToday();
        const ipAddress = resolveClientIp(req);

        const result = await prisma.$transaction(async (tx) => {
          const attendance = await tx.attendance.findUnique({
            where: { userId_date: { userId: req.user.userId, date: today } },
            include: { breaks: { where: { endTime: null } } },
          });

          if (!attendance) {
            throw { status: 404, message: "Cannot initiate a break without an active check-in today." };
          }

          if (attendance.currentState === "CHECKED_OUT") {
            throw { status: 400, message: "Cannot start a break after checking out." };
          }

          if (attendance.currentState === "ON_BREAK" || attendance.breaks.length > 0) {
            throw { status: 409, message: "An active break session is already in progress." };
          }

          const [newBreak] = await Promise.all([
            tx.attendanceBreak.create({
              data: {
                attendanceId: attendance.id,
                breakType: dto.breakType || "LUNCH",
                startTime: new Date(),
                ipAddress,
              },
            }),
            tx.attendance.update({
              where: { id: attendance.id },
              data: { currentState: "ON_BREAK" },
            }),
          ]);

          return newBreak;
        });

        return res.status(200).json(result);
      } catch (err) {
        if (err.status) {
          return res.status(err.status).json({ message: err.message });
        }
        next(err);
      }
    }
  );

  // POST /api/attendance/break-end
  router.post(
    "/break-end",
    (req, res, next) => officeIpGuard(prisma, req, res, next),
    async (req, res, next) => {
      try {
        const today = getUtcMidnightToday();

        const result = await prisma.$transaction(async (tx) => {
          const attendance = await tx.attendance.findUnique({
            where: { userId_date: { userId: req.user.userId, date: today } },
            include: { breaks: { where: { endTime: null } } },
          });

          if (!attendance) {
            throw { status: 404, message: "Attendance check-in record not found." };
          }

          if (attendance.currentState !== "ON_BREAK" || attendance.breaks.length === 0) {
            throw { status: 400, message: "No active open break found to end." };
          }

          const activeBreak = attendance.breaks[0];
          const now = new Date();
          const durationMinutes = Math.max(
            1,
            Math.round((now.getTime() - activeBreak.startTime.getTime()) / (1000 * 60))
          );

          await tx.attendanceBreak.update({
            where: { id: activeBreak.id },
            data: {
              endTime: now,
              durationMinutes,
            },
          });

          return tx.attendance.update({
            where: { id: attendance.id },
            data: {
              currentState: "CHECKED_IN",
              totalBreakMinutes: { increment: durationMinutes },
            },
            include: {
              breaks: { orderBy: { startTime: "desc" } },
            },
          });
        });

        return res.status(200).json(result);
      } catch (err) {
        if (err.status) {
          return res.status(err.status).json({ message: err.message });
        }
        next(err);
      }
    }
  );

  // POST /api/attendance/check-out
  router.post(
    "/check-out",
    (req, res, next) => officeIpGuard(prisma, req, res, next),
    async (req, res, next) => {
      try {
        const dto = req.body || {};
        const incomingSecret = (dto.qrSecret || "").trim();
        const validStaticSecret = process.env.OFFICE_QR_SECRET;

        let isQrValid = false;

        // 1. Check if it's the static office token
        if (incomingSecret && incomingSecret === validStaticSecret) {
          isQrValid = true;
        }

        // 2. Check if it's a dynamic JSON tenant QR code
        if (!isQrValid && incomingSecret) {
          try {
            const parsed = JSON.parse(incomingSecret);
            if (parsed && parsed.type === "OFFICE_ATTENDANCE_QR") {
              if (parsed.orgId && parsed.orgId === req.user.organizationId) {
                const secret = process.env.JWT_SECRET || "hrms_secret";
                const rawData = `tenant:${parsed.orgId}:slug:${parsed.slug || ""}:ip:${parsed.officeIp || "any"}`;
                const expectedSig = crypto.createHmac("sha256", secret).update(rawData).digest("hex");
                if (expectedSig === parsed.sig) {
                  isQrValid = true;
                }
              }
            }
          } catch {
            // Not a JSON string
          }
        }

        if (!isQrValid) {
          return res.status(403).json({
            message: "Invalid or missing office QR code. Please scan the official Office QR code to clock out.",
          });
        }

        const today = getUtcMidnightToday();

        const result = await prisma.$transaction(async (tx) => {
          const attendance = await tx.attendance.findUnique({
            where: { userId_date: { userId: req.user.userId, date: today } },
          });

          if (!attendance) {
            throw { status: 404, message: "Cannot check out without a check-in record for today." };
          }

          if (attendance.currentState === "ON_BREAK") {
            throw { status: 400, message: "You are currently on break. End break before check-out." };
          }

          if (attendance.currentState === "CHECKED_OUT") {
            throw { status: 409, message: "You have already checked out for today." };
          }

          const now = new Date();
          const elapsedTotalMinutes = Math.max(
            0,
            Math.round((now.getTime() - attendance.checkInTime.getTime()) / (1000 * 60))
          );
          const totalWorkMinutes = Math.max(0, elapsedTotalMinutes - attendance.totalBreakMinutes);

          return tx.attendance.update({
            where: { id: attendance.id },
            data: {
              checkOutTime: now,
              currentState: "CHECKED_OUT",
              totalWorkMinutes,
              punchOutLatitude: dto.latitude || null,
              punchOutLongitude: dto.longitude || null,
              punchOutAddress: dto.address || null,
            },
            include: {
              breaks: { orderBy: { startTime: "desc" } },
            },
          });
        });

        return res.status(200).json(result);
      } catch (err) {
        if (err.status) {
          return res.status(err.status).json({ message: err.message });
        }
        next(err);
      }
    }
  );

  // GET /api/attendance/admin/today
  router.get("/admin/today", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const today = getUtcMidnightToday();
      const records = await prisma.attendance.findMany({
        where: { organizationId: req.user.organizationId, date: today },
        include: {
          user: {
            select: {
              id: true,
              employeeId: true,
              fullName: true,
              avatarUrl: true,
              department: { select: { name: true } },
            },
          },
          breaks: {
            orderBy: { startTime: "desc" },
          },
        },
        orderBy: { checkInTime: "asc" },
      });

      return res.status(200).json(records);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/attendance/admin/by-date
  router.get("/admin/by-date", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const { date } = req.query;
      if (!date) {
        return res.status(400).json({ message: "Date query parameter is required." });
      }

      const targetDate = new Date(date);
      const records = await prisma.attendance.findMany({
        where: { organizationId: req.user.organizationId, date: targetDate },
        include: {
          user: {
            select: {
              id: true,
              employeeId: true,
              fullName: true,
              avatarUrl: true,
              department: { select: { name: true } },
            },
          },
          breaks: {
            orderBy: { startTime: "desc" },
          },
        },
        orderBy: { checkInTime: "asc" },
      });

      return res.status(200).json(records);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAttendanceRouter };
