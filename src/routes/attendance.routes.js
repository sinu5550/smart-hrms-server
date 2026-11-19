const express = require("express");
const crypto = require("crypto");
const { authenticateToken, requireRoles, requirePermissions, officeIpGuard, resolveClientIp } = require("../middleware");

function createAttendanceRouter(prisma) {
  const router = express.Router();

  // Calculate Attendance Date based on Organization's Day Cutoff Hour (e.g. 06:00 AM)
  // If an employee punches at 12:25 AM, 2:00 AM or 5:30 AM (before 6:00 AM),
  // it is counted towards the previous day's shift, not a brand new day!
  async function getOrganizationAttendanceDate(organizationId, dateInput = new Date()) {
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { dayCutoffHour: true },
    });
    const cutoffHour = org?.dayCutoffHour ?? 6; // Default to 6:00 AM if not set

    // Convert dateInput to Asia/Dhaka local time
    const inputDate = new Date(dateInput);
    // Subtract cutoffHour hours so that e.g. 05:59 AM belongs to previous calendar day
    const shifted = new Date(inputDate.getTime() - cutoffHour * 3600 * 1000);
    const localYMD = shifted.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" }); // "YYYY-MM-DD"
    const [y, m, d] = localYMD.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  }

  function getUtcMidnightToday() {
    const now = new Date();
    // Default 6 hours offset for BD time zone (06:00 AM cutoff)
    const shifted = new Date(now.getTime() - 6 * 3600 * 1000);
    const localYMD = shifted.toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
    const [y, m, d] = localYMD.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  }

  async function calculateShiftStatus(organizationId, userId, checkInDate) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { shiftId: true, attendanceExempt: true, role: true },
    });

    if (user?.attendanceExempt || user?.role === "OWNER") {
      return { status: "PRESENT", requiresLateReason: false, lateMinutes: 0, lateReasonStatus: null };
    }

    let setting = user?.shiftId
      ? await prisma.officeSetting.findUnique({ where: { id: user.shiftId } })
      : null;

    if (!setting) {
      setting = await prisma.officeSetting.findFirst({
        where: { organizationId, isDefault: true },
      });
    }

    if (!setting) {
      setting = await prisma.officeSetting.findFirst({
        where: { organizationId },
      });
    }

    const startTimeStr = setting?.startTime || "09:00";
    const graceMinutes = setting?.gracePeriodMinutes ?? 30;
    const requireLateReason = Boolean(setting?.requireLateReason);
    const lateThresholdMins = setting?.lateReasonThresholdMins ?? 30;

    const [startHour, startMinute] = startTimeStr.split(":").map(Number);
    const shiftStartTotalMinutes = startHour * 60 + startMinute;
    const cutoffTotalMinutes = shiftStartTotalMinutes + graceMinutes;
    const extremeThresholdTotalMinutes = cutoffTotalMinutes + lateThresholdMins;

    // Convert checkInDate to Bangladesh time (UTC+6)
    const checkIn = new Date(checkInDate);
    const checkInTotalMinutes = ((checkIn.getUTCHours() + 6) % 24) * 60 + checkIn.getUTCMinutes();

    if (checkInTotalMinutes > cutoffTotalMinutes) {
      const lateMinutes = checkInTotalMinutes - shiftStartTotalMinutes;
      const requiresLateReason = requireLateReason && (checkInTotalMinutes > extremeThresholdTotalMinutes);
      return {
        status: "LATE",
        requiresLateReason,
        lateMinutes,
        lateReasonStatus: requiresLateReason ? "PENDING" : null,
      };
    }

    return { status: "PRESENT", requiresLateReason: false, lateMinutes: 0, lateReasonStatus: null };
  }

  // Calculate Overtime Minutes based on user's shift settings and check-out time
  // RULES:
  // 1. Check user's assigned shift or default org shift.
  // 2. Calculate the required shift duty duration in minutes (shiftEnd - shiftStart).
  // 3. User's total work minutes must meet or exceed this required duty duration first!
  // 4. Overtime starts only after duty duration is fulfilled AND after the admin overtimeThresholdMins buffer has passed.
  async function calculateOvertimeMinutes(organizationId, userId, checkOutDate, totalWorkMinutes = null) {
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

      if (!setting) {
        setting = await prisma.officeSetting.findFirst({
          where: { organizationId },
        });
      }

      const startTimeStr = setting?.startTime || "09:00";
      const endTimeStr = setting?.endTime || "18:00";
      const thresholdMins = typeof setting?.overtimeThresholdMins === "number" ? setting.overtimeThresholdMins : 30;

      const [startHour, startMinute] = startTimeStr.split(":").map(Number);
      const [endHour, endMinute] = endTimeStr.split(":").map(Number);

      const shiftStartMins = startHour * 60 + startMinute;
      let shiftEndMins = endHour * 60 + endMinute;
      if (shiftEndMins < shiftStartMins) {
        // Overnight shift (e.g. 20:00 to 05:00)
        shiftEndMins += 24 * 60;
      }

      // Check-out time in Bangladesh time (+06:00)
      const localCheckOut = new Date(checkOutDate.getTime() + 6 * 60 * 60 * 1000);
      let checkOutMins = localCheckOut.getUTCHours() * 60 + localCheckOut.getUTCMinutes();
      if (shiftEndMins >= 24 * 60 && checkOutMins < shiftStartMins) {
        checkOutMins += 24 * 60;
      }

      // Overtime Rule: Counted only when checkout occurs AFTER shiftEnd + buffer threshold (e.g. after 6:30 for 6:00 end + 30 min buffer)
      // Overtime minutes = minutes worked past shift end (e.g., 6:40 checkout = 40 mins overtime, or 10 mins beyond buffer)
      // Standard rule: Once buffer is crossed (> shiftEndMins + thresholdMins), overtime is counted past shift end:
      if (checkOutMins > shiftEndMins + thresholdMins) {
        return checkOutMins - shiftEndMins;
      }
      return 0;
    } catch (e) {
      console.warn("calculateOvertimeMinutes notice:", e.message);
      return 0;
    }
  }

  // All attendance endpoints require authentication
  router.use(authenticateToken);

  // GET /api/attendance/today-status
  router.get("/today-status", async (req, res, next) => {
    try {
      const today = await getOrganizationAttendanceDate(req.user.organizationId);
      let attendance = await prisma.attendance.findUnique({
        where: { userId_date: { userId: req.user.userId, date: today } },
        include: {
          breaks: {
            orderBy: { startTime: "desc" },
          },
        },
      });

      // If user is not yet marked checked in today, trigger a lightweight JIT auto-sync from device
      if (!attendance && typeof global.g_triggerAutoDeviceSync === "function") {
        await global.g_triggerAutoDeviceSync("today_status_jit");
        attendance = await prisma.attendance.findUnique({
          where: { userId_date: { userId: req.user.userId, date: today } },
          include: {
            breaks: {
              orderBy: { startTime: "desc" },
            },
          },
        });
      }

      const user = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: {
          attendanceExempt: true,
          role: true,
          departmentId: true,
          rosterOffDays: true,
          shiftId: true,
          shift: {
            select: { id: true, shiftName: true, startTime: true, endTime: true, gracePeriodMinutes: true },
          },
          organization: {
            select: {
              ownerEmail: true,
              hasRosterDuty: true,
              rosterDepartmentIds: true,
            },
          },
        },
      });
      const isOwner = Boolean(
        user?.role === "OWNER" ||
        (user?.organization?.ownerEmail && req.user.email?.toLowerCase() === user.organization.ownerEmail.toLowerCase())
      );
      const isExempt = Boolean(isOwner || user?.attendanceExempt);

      // Check if employee is in a Roster-enabled Department
      const orgHasRoster = Boolean(user?.organization?.hasRosterDuty);
      const rosterDeptIds = Array.isArray(user?.organization?.rosterDepartmentIds)
        ? user.organization.rosterDepartmentIds
        : [];
      const isRosterEmployee = Boolean(orgHasRoster && user?.departmentId && rosterDeptIds.includes(user.departmentId));

      let shiftInfo = user?.shift || null;
      if (!shiftInfo && req.user.organizationId) {
        shiftInfo = await prisma.officeSetting.findFirst({
          where: { organizationId: req.user.organizationId, isDefault: true },
          select: { id: true, shiftName: true, startTime: true, endTime: true, gracePeriodMinutes: true },
        }) || await prisma.officeSetting.findFirst({
          where: { organizationId: req.user.organizationId },
          select: { id: true, shiftName: true, startTime: true, endTime: true, gracePeriodMinutes: true },
        });
      }

      const rosterDetails = isRosterEmployee
        ? {
            isRosterEmployee: true,
            shiftName: shiftInfo?.shiftName || "Standard Shift",
            startTime: shiftInfo?.startTime || "09:00",
            endTime: shiftInfo?.endTime || "18:00",
            offDays: Array.isArray(user?.rosterOffDays) ? user.rosterOffDays : [],
          }
        : null;

      // Check if user has an active/pending/approved outwork request today
      const todayStartUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0, 0));
      const todayEndUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59, 999));
      const activeOutwork = await prisma.outworkRequest.findFirst({
        where: {
          userId: req.user.userId,
          organizationId: req.user.organizationId,
          visitDate: { gte: todayStartUtc, lte: todayEndUtc },
          status: { in: ["PENDING", "APPROVED"] },
        },
        select: { id: true, destination: true, purpose: true, status: true },
      });

      if (!attendance) {
        return res.status(200).json({
          checkedIn: false,
          checkedOut: false,
          attendance: null,
          isExempt,
          rosterDetails,
          activeOutwork: activeOutwork || null,
        });
      }

      return res.status(200).json({
        checkedIn: true,
        checkedOut: attendance.currentState === "CHECKED_OUT",
        attendance,
        isExempt,
        rosterDetails,
        activeOutwork: activeOutwork || null,
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

        const today = await getOrganizationAttendanceDate(req.user.organizationId);
        const now = new Date();

        const existingRecord = await prisma.attendance.findUnique({
          where: { userId_date: { userId: req.user.userId, date: today } },
        });

        if (existingRecord) {
          return res.status(409).json({ message: "Attendance check-in already recorded for today." });
        }

        const ipAddress = resolveClientIp(req);
        const shiftEval = await calculateShiftStatus(req.user.organizationId, req.user.userId, now);

        const record = await prisma.attendance.create({
          data: {
            organizationId: req.user.organizationId,
            userId: req.user.userId,
            date: today,
            checkInTime: now,
            currentState: "CHECKED_IN",
            status: shiftEval.status,
            lateReasonStatus: shiftEval.lateReasonStatus,
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
        const today = await getOrganizationAttendanceDate(req.user.organizationId);
        const ipAddress = resolveClientIp(req);

        // Pre-check: If employee punched at device but auto-sync hasn't run yet, run JIT sync
        let preAttendance = await prisma.attendance.findUnique({
          where: { userId_date: { userId: req.user.userId, date: today } },
          select: { id: true },
        });

        if (!preAttendance && typeof global.g_triggerAutoDeviceSync === "function") {
          await global.g_triggerAutoDeviceSync("break_start_jit");
        }

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
        const today = await getOrganizationAttendanceDate(req.user.organizationId);

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
  // Supports regular office QR checkout AND outside Outwork checkout!
  router.post(
    "/check-out",
    async (req, res, next) => {
      // Check if user has an active outwork request today or attendance was via outwork
      const today = await getOrganizationAttendanceDate(req.user.organizationId);
      const todayStartUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 0, 0, 0));
      const todayEndUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 23, 59, 59, 999));

      const hasOutwork = await prisma.outworkRequest.findFirst({
        where: {
          userId: req.user.userId,
          organizationId: req.user.organizationId,
          visitDate: { gte: todayStartUtc, lte: todayEndUtc },
          status: { in: ["PENDING", "APPROVED"] },
        },
        select: { id: true, destination: true },
      });

      const currentAtt = await prisma.attendance.findUnique({
        where: { userId_date: { userId: req.user.userId, date: today } },
        select: { punchInDeviceType: true },
      });

      // If user has outwork today or checked in via OUTWORK, bypass office IP restriction!
      if (hasOutwork || currentAtt?.punchInDeviceType === "OUTWORK" || req.body?.isOutworkCheckOut) {
        req.isOutworkAllowed = true;
        return next();
      }

      // Otherwise enforce normal office Wi-Fi check
      return officeIpGuard(prisma, req, res, next);
    },
    async (req, res, next) => {
      try {
        const dto = req.body || {};
        const incomingSecret = (dto.qrSecret || "").trim();
        const validStaticSecret = process.env.OFFICE_QR_SECRET;

        let isQrValid = false;

        // If outwork checkout is allowed, QR code is NOT mandatory
        if (req.isOutworkAllowed || dto.isOutworkCheckOut) {
          isQrValid = true;
        } else {
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
        }

        const today = await getOrganizationAttendanceDate(req.user.organizationId);

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
          // Total work hours includes break time (break time is paid / not deducted)
          const totalWorkMinutes = elapsedTotalMinutes;
          const overtimeMinutes = await calculateOvertimeMinutes(
            req.user.organizationId,
            req.user.userId,
            now,
            totalWorkMinutes
          );

          const punchOutAddress = dto.address || (req.isOutworkAllowed ? "Outwork Remote Checkout" : null);

          return tx.attendance.update({
            where: { id: attendance.id },
            data: {
              checkOutTime: now,
              currentState: "CHECKED_OUT",
              totalWorkMinutes,
              overtimeMinutes,
              punchOutLatitude: dto.latitude || null,
              punchOutLongitude: dto.longitude || null,
              punchOutAddress,
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

  // POST /api/attendance/submit-late-reason (Employee submits explanation for late check-in)
  router.post("/submit-late-reason", async (req, res, next) => {
    try {
      const { attendanceId, reason } = req.body || {};
      const userId = req.user.userId;
      const organizationId = req.user.organizationId;

      if (!reason || !reason.trim()) {
        return res.status(400).json({ message: "Late reason explanation is required." });
      }

      let att = null;
      if (attendanceId) {
        att = await prisma.attendance.findFirst({
          where: { id: attendanceId, userId, organizationId },
        });
      } else {
        const today = await getOrganizationAttendanceDate(organizationId);
        att = await prisma.attendance.findUnique({
          where: { userId_date: { userId, date: today } },
        });
      }

      if (!att) {
        return res.status(404).json({ message: "Attendance record not found." });
      }

      const updated = await prisma.attendance.update({
        where: { id: att.id },
        data: {
          lateReason: reason.trim(),
          lateReasonStatus: "PENDING",
        },
      });

      return res.status(200).json({
        success: true,
        message: "Late reason submitted successfully. Awaiting HR/Admin approval.",
        attendance: updated,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/attendance/admin/late-requests (List pending/all late reason submissions for HR/Admin)
  router.get("/admin/late-requests", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const { status } = req.query; // PENDING, APPROVED, REJECTED, ALL

      let whereClause = {
        organizationId,
        lateReasonStatus: { not: null },
      };

      if (status && status !== "ALL") {
        whereClause.lateReasonStatus = status;
      }

      const requests = await prisma.attendance.findMany({
        where: whereClause,
        orderBy: [{ date: "desc" }, { checkInTime: "desc" }],
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              employeeId: true,
              avatarUrl: true,
              department: { select: { id: true, name: true } },
              designation: { select: { id: true, name: true } },
              shift: {
                select: {
                  id: true,
                  shiftName: true,
                  startTime: true,
                  endTime: true,
                  gracePeriodMinutes: true,
                  lateReasonThresholdMins: true,
                },
              },
            },
          },
        },
      });

      return res.status(200).json(requests);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /api/attendance/admin/late-requests/:id/action (Approve or Reject late reason)
  router.patch("/admin/late-requests/:id/action", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const { action, note } = req.body || {}; // action: "APPROVE" | "REJECT"
      const organizationId = req.user.organizationId;
      const reviewerId = req.user.userId;

      if (!["APPROVE", "REJECT"].includes(action)) {
        return res.status(400).json({ message: "Action must be either APPROVE or REJECT." });
      }

      const att = await prisma.attendance.findFirst({
        where: { id, organizationId },
      });

      if (!att) {
        return res.status(404).json({ message: "Attendance record not found." });
      }

      let updateData = {
        lateReasonReviewedAt: new Date(),
        lateReasonReviewerId: reviewerId,
        lateReasonReviewNote: note || null,
      };

      if (action === "APPROVE") {
        // If approved: Keep real checkInTime untouched! Mark status as counted (LATE or PRESENT).
        updateData.lateReasonStatus = "APPROVED";
      } else {
        // If rejected: Attendance is not counted / marked ABSENT
        updateData.lateReasonStatus = "REJECTED";
        updateData.status = "ABSENT";
      }

      const updated = await prisma.attendance.update({
        where: { id },
        data: updateData,
        include: {
          user: {
            select: { id: true, fullName: true, employeeId: true },
          },
        },
      });

      return res.status(200).json({
        success: true,
        message: action === "APPROVE" ? "Late reason approved. Attendance is counted." : "Late reason rejected. Attendance marked as absent.",
        attendance: updated,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/attendance/admin/manual-punch
  // Allows authorized HR / Admin (attendance.manage permission) to create or edit manual check-in / check-out
  // and optionally override status to "OFF_DAY", "ABSENT", "OFF_DAY_DUTY", or "AUTO"
  router.post("/admin/manual-punch", requirePermissions(prisma, "attendance.manage"), async (req, res, next) => {
    try {
      const organizationId = req.user.organizationId;
      const { userId, date, checkInTime, checkOutTime, note, statusOverride } = req.body || {};

      if (!userId || !date) {
        return res.status(400).json({ message: "userId and date are required." });
      }

      if (!checkInTime && !checkOutTime && !statusOverride) {
        return res.status(400).json({ message: "Provide at least Check-In/Check-Out time or a Status Selection." });
      }

      const targetUser = await prisma.user.findFirst({
        where: { id: userId, organizationId, isDeleted: false },
        select: { id: true, fullName: true, shiftId: true, attendanceExempt: true, role: true },
      });

      if (!targetUser) {
        return res.status(404).json({ message: "Employee not found." });
      }

      // Convert date string YYYY-MM-DD to UTC midnight date
      const [y, m, d] = date.split("-").map(Number);
      const attendanceDate = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));

      // Robust time parser supporting "10:13 AM", "07:31 PM", "19:30", "10:13", or ISO strings
      const parseTimeStringToDate = (timeStr, baseDayOffset = 0) => {
        if (!timeStr || typeof timeStr !== "string") return null;
        const trimmed = timeStr.trim();
        if (!trimmed || trimmed === "—" || trimmed === "-") return null;

        // ISO format (e.g., 2026-11-02T10:13:00.000Z)
        if (trimmed.includes("T")) {
          const parsed = new Date(trimmed);
          return isNaN(parsed.getTime()) ? null : parsed;
        }

        // Match 12-hour (e.g. "10:13 AM", "07:31 PM") or 24-hour (e.g. "19:31", "10:13")
        const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
        if (match) {
          let hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const meridiem = match[3] ? match[3].toUpperCase() : null;

          if (meridiem === "PM" && hours < 12) {
            hours += 12;
          } else if (meridiem === "AM" && hours === 12) {
            hours = 0;
          }

          // Bangladesh time is UTC+6 -> UTC hour = hours - 6
          const dt = new Date(Date.UTC(y, m - 1, d + baseDayOffset, hours - 6, minutes, 0, 0));
          return isNaN(dt.getTime()) ? null : dt;
        }

        // Fallback standard Date parse
        const fallback = new Date(`${date}T${trimmed}`);
        return isNaN(fallback.getTime()) ? null : fallback;
      };

      // Parse checkIn and checkOut dates if provided
      let parsedCheckIn = parseTimeStringToDate(checkInTime);
      let parsedCheckOut = parseTimeStringToDate(checkOutTime);

      // If overnight check-out is before check-in, advance checkout to next calendar day
      if (parsedCheckIn && parsedCheckOut && parsedCheckOut < parsedCheckIn) {
        parsedCheckOut = parseTimeStringToDate(checkOutTime, 1);
      }

      // Calculate shift status and overtime
      let shiftStatus = "PRESENT";
      let totalWorkMinutes = 0;
      let overtimeMinutes = 0;

      if (parsedCheckIn) {
        const statusCalc = await calculateShiftStatus(organizationId, targetUser.id, parsedCheckIn);
        shiftStatus = statusCalc.status;
      }

      if (parsedCheckIn && parsedCheckOut) {
        totalWorkMinutes = Math.max(0, Math.round((parsedCheckOut.getTime() - parsedCheckIn.getTime()) / (1000 * 60)));
        overtimeMinutes = await calculateOvertimeMinutes(organizationId, targetUser.id, parsedCheckOut, totalWorkMinutes);
      }

      // Handle optional status override tag if provided by admin:
      // "OFF_DAY", "ABSENT", "OFF_DAY_DUTY"
      let finalNote = note ? note.trim() : "";
      if (statusOverride && statusOverride !== "AUTO") {
        if (statusOverride === "OFF_DAY") {
          finalNote = `[OVERRIDE:OFF_DAY] ${finalNote}`.trim();
        } else if (statusOverride === "ABSENT") {
          finalNote = `[OVERRIDE:ABSENT] ${finalNote}`.trim();
          shiftStatus = "ABSENT";
        } else if (statusOverride === "OFF_DAY_DUTY") {
          finalNote = `[OVERRIDE:OFF_DAY_DUTY] ${finalNote}`.trim();
        }
      }

      // Upsert attendance record for targetUser on attendanceDate
      const existing = await prisma.attendance.findUnique({
        where: { userId_date: { userId: targetUser.id, date: attendanceDate } },
      });

      let savedRecord;
      const callerIp = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "127.0.0.1";
      const normalizedIp = typeof callerIp === "string" ? callerIp.split(",")[0].trim() : "127.0.0.1";

      if (existing) {
        const updateData = {
          updatedAt: new Date(),
        };
        if (parsedCheckIn) updateData.checkInTime = parsedCheckIn;
        if (parsedCheckOut) {
          updateData.checkOutTime = parsedCheckOut;
          updateData.currentState = "CHECKED_OUT";
        } else if (!existing.checkOutTime && parsedCheckIn) {
          updateData.currentState = "CHECKED_IN";
        }
        if (parsedCheckIn && (parsedCheckOut || existing.checkOutTime)) {
          const effOut = parsedCheckOut || existing.checkOutTime;
          totalWorkMinutes = Math.max(0, Math.round((effOut.getTime() - parsedCheckIn.getTime()) / (1000 * 60)));
          updateData.totalWorkMinutes = totalWorkMinutes;
          updateData.overtimeMinutes = await calculateOvertimeMinutes(organizationId, targetUser.id, effOut, totalWorkMinutes);
        }
        if (statusOverride === "OFF_DAY" && !parsedCheckIn && !parsedCheckOut) {
          updateData.totalWorkMinutes = 0;
          updateData.overtimeMinutes = 0;
          updateData.currentState = "NOT_CHECKED_IN";
        }
        if (shiftStatus) updateData.status = shiftStatus;
        if (finalNote) updateData.punchInAddress = `Manual Adjustment: ${finalNote}`;

        savedRecord = await prisma.attendance.update({
          where: { id: existing.id },
          data: updateData,
          include: {
            user: { select: { id: true, fullName: true, employeeId: true } },
          },
        });
      } else {
        // When there is no check-in/out time provided (e.g., admin explicitly forces Day-Off or Absent):
        // Provide a valid non-null placeholder checkInTime at UTC noon of that date
        const fallbackCheckInTime = parsedCheckIn || new Date(Date.UTC(y, m - 1, d, 6, 0, 0, 0));

        savedRecord = await prisma.attendance.create({
          data: {
            organizationId,
            userId: targetUser.id,
            date: attendanceDate,
            checkInTime: fallbackCheckInTime,
            checkOutTime: parsedCheckOut || null,
            currentState: parsedCheckOut ? "CHECKED_OUT" : (parsedCheckIn ? "CHECKED_IN" : "NOT_CHECKED_IN"),
            status: shiftStatus,
            totalWorkMinutes,
            overtimeMinutes,
            ipAddress: normalizedIp,
            punchInAddress: finalNote ? `Manual Adjustment: ${finalNote}` : "Manual HR Entry",
            punchInDeviceType: "MANUAL_ENTRY",
          },
          include: {
            user: { select: { id: true, fullName: true, employeeId: true } },
          },
        });
      }

      return res.status(200).json({
        success: true,
        message: `Attendance for ${targetUser.fullName} on ${date} saved successfully.`,
        record: savedRecord,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/attendance/admin/today
  router.get("/admin/today", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const today = await getOrganizationAttendanceDate(req.user.organizationId);
      const org = await prisma.organization.findUnique({
        where: { id: req.user.organizationId },
        select: { ownerEmail: true },
      });
      const ownerEmail = org?.ownerEmail?.toLowerCase();

      const records = await prisma.attendance.findMany({
        where: {
          organizationId: req.user.organizationId,
          date: today,
          ...(ownerEmail
            ? {
                user: {
                  email: { not: ownerEmail },
                },
              }
            : {}),
        },
        include: {
          user: {
            select: {
              id: true,
              employeeId: true,
              fullName: true,
              email: true,
              avatarUrl: true,
              department: { select: { id: true, name: true } },
              designation: { select: { id: true, name: true } },
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
      const { date, startDate, endDate, userId } = req.query;
      if (!date && !startDate) {
        return res.status(400).json({ message: "Date or startDate query parameter is required." });
      }

      const org = await prisma.organization.findUnique({
        where: { id: req.user.organizationId },
        select: { ownerEmail: true },
      });
      const ownerEmail = org?.ownerEmail?.toLowerCase();

      let dateFilter = {};
      if (startDate && endDate) {
        dateFilter = {
          gte: new Date(startDate),
          lte: new Date(endDate),
        };
      } else if (startDate) {
        dateFilter = {
          gte: new Date(startDate),
        };
      } else {
        dateFilter = new Date(date);
      }

      const records = await prisma.attendance.findMany({
        where: {
          organizationId: req.user.organizationId,
          date: dateFilter,
          ...(userId && userId !== "ALL" ? { userId } : {}),
          ...(ownerEmail
            ? {
                user: {
                  email: { not: ownerEmail },
                },
              }
            : {}),
        },
        include: {
          user: {
            select: {
              id: true,
              employeeId: true,
              fullName: true,
              email: true,
              avatarUrl: true,
              attendanceExempt: true,
              role: true,
              shiftId: true,
              rosterOffDays: true,
              shift: {
                select: {
                  id: true,
                  shiftName: true,
                  startTime: true,
                  endTime: true,
                  gracePeriodMinutes: true,
                },
              },
              department: { select: { id: true, name: true } },
              designation: { select: { id: true, name: true } },
            },
          },
          breaks: {
            orderBy: { startTime: "desc" },
          },
        },
        orderBy: [{ date: "desc" }, { checkInTime: "asc" }],
      });

      // Default org shift fallback
      const defaultOrgShift = await prisma.officeSetting.findFirst({
        where: { organizationId: req.user.organizationId, isDefault: true },
      }) || await prisma.officeSetting.findFirst({ where: { organizationId: req.user.organizationId } });

      // Dynamically recompute status and delay based on employee's current active shift
      const evaluatedRecords = records.map((rec) => {
        if (rec.user?.attendanceExempt || rec.user?.role === "OWNER") {
          return { ...rec, status: "PRESENT", delayMinutes: 0 };
        }

        const shift = rec.user?.shift || defaultOrgShift;
        if (!shift?.startTime) {
          return rec;
        }

        const [sh, sm] = shift.startTime.split(":").map(Number);
        const shiftStartMins = sh * 60 + sm;
        const grace = shift.gracePeriodMinutes ?? 30;

        const checkIn = new Date(rec.checkInTime);
        const checkInMins = ((checkIn.getUTCHours() + 6) % 24) * 60 + checkIn.getUTCMinutes();
        const delay = checkInMins - shiftStartMins;

        // If late reason was rejected by HR, status remains ABSENT
        if (rec.lateReasonStatus === "REJECTED") {
          return { ...rec, status: "ABSENT", delayMinutes: Math.max(0, delay) };
        }

        const dynamicStatus = delay > grace ? "LATE" : "PRESENT";

        // Dynamically calculate overtime based on running shift
        let dynamicOvertime = rec.overtimeMinutes || 0;
        if (rec.checkOutTime && shift?.endTime) {
          const [endH, endM] = shift.endTime.split(":").map(Number);
          let sEndMins = endH * 60 + endM;
          const threshold = typeof shift.overtimeThresholdMins === "number" ? shift.overtimeThresholdMins : 30;
          if (sEndMins < shiftStartMins) sEndMins += 24 * 60;

          const cOut = new Date(rec.checkOutTime);
          let cOutMins = ((cOut.getUTCHours() + 6) % 24) * 60 + cOut.getUTCMinutes();
          if (sEndMins >= 24 * 60 && cOutMins < shiftStartMins) cOutMins += 24 * 60;

          if (cOutMins > sEndMins + threshold) {
            dynamicOvertime = cOutMins - sEndMins;
          } else {
            dynamicOvertime = 0;
          }
        }

        return {
          ...rec,
          status: dynamicStatus,
          delayMinutes: Math.max(0, delay),
          overtimeMinutes: dynamicOvertime,
        };
      });

      return res.status(200).json(evaluatedRecords);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/attendance/admin/individual-report
  // Generates complete single-employee attendance breakdown with daily history, stats, and metadata
  // Also accessible by employees viewing their own reports (or HR/ADMIN viewing any)
  router.get("/admin/individual-report", async (req, res, next) => {
    try {
      let { userId, month, startDate: qStartDate, endDate: qEndDate } = req.query;
      const organizationId = req.user.organizationId;
      const callerRole = req.user.role;
      const callerId = req.user.userId;

      // If called by normal EMPLOYEE, force userId to caller's own id for strict security
      if (callerRole === "EMPLOYEE") {
        userId = callerId;
      }

      if (!userId) {
        return res.status(400).json({ message: "userId query parameter is required." });
      }

      const user = await prisma.user.findFirst({
        where: { id: userId, organizationId, isDeleted: false },
        select: {
          id: true,
          employeeId: true,
          fullName: true,
          email: true,
          avatarUrl: true,
          rosterOffDays: true,
          department: { select: { id: true, name: true } },
          designation: { select: { id: true, name: true } },
          shift: { select: { id: true, shiftName: true, startTime: true, endTime: true, gracePeriodMinutes: true } },
          branch: { select: { id: true, name: true } },
        },
      });

      if (!user) {
        return res.status(404).json({ message: "Employee not found." });
      }

      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true, logoUrl: true, weekendDays: true, hasRosterDuty: true, rosterDepartmentIds: true },
      });

      // Default shift fallback
      const defaultShift = await prisma.officeSetting.findFirst({
        where: { organizationId, isDefault: true },
      }) || await prisma.officeSetting.findFirst({ where: { organizationId } });

      const empShift = user.shift || defaultShift;

      // Determine date range: either from month (YYYY-MM) or startDate/endDate or default to current month
      const now = new Date();
      const currentMonthStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(now).slice(0, 7);
      const targetMonth = month || (qStartDate ? qStartDate.slice(0, 7) : currentMonthStr);

      let startDate = qStartDate;
      let endDate = qEndDate;

      if (!startDate || !endDate) {
        const [y, m] = targetMonth.split("-").map(Number);
        startDate = `${targetMonth}-01`;
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        endDate = `${targetMonth}-${String(lastDay).padStart(2, "0")}`;
      }

      const [sY, sM, sD] = startDate.split("-").map(Number);
      const [eY, eM, eD] = endDate.split("-").map(Number);
      const startUtc = new Date(Date.UTC(sY, sM - 1, sD, 0, 0, 0, 0));
      const endUtc = new Date(Date.UTC(eY, eM - 1, eD, 23, 59, 59, 999));

      // Fetch attendances in range
      const attendances = await prisma.attendance.findMany({
        where: {
          userId: user.id,
          organizationId,
          date: { gte: startUtc, lte: endUtc },
        },
        include: {
          breaks: { orderBy: { startTime: "asc" } },
        },
        orderBy: { date: "asc" },
      });

      const attMap = new Map();
      attendances.forEach((a) => {
        const dStr = new Date(a.date).toISOString().split("T")[0];
        attMap.set(dStr, a);
      });

      // Fetch approved leaves in range
      const leaves = await prisma.leaveRequest.findMany({
        where: {
          userId: user.id,
          organizationId,
          status: "APPROVED",
          startDate: { lte: endUtc },
          endDate: { gte: startUtc },
        },
        select: { startDate: true, endDate: true, reason: true },
      });

      // Fetch official holidays in range
      const holidays = await prisma.holiday.findMany({
        where: {
          organizationId,
          fromDate: { lte: endUtc },
          toDate: { gte: startUtc },
        },
        select: { fromDate: true, toDate: true, title: true },
      });

      const holidayDateStrs = new Map();
      holidays.forEach((h) => {
        const hStart = new Date(h.fromDate);
        const hEnd = new Date(h.toDate);
        for (let d = new Date(hStart); d <= hEnd; d.setUTCDate(d.getUTCDate() + 1)) {
          holidayDateStrs.set(d.toISOString().split("T")[0], h.title);
        }
      });

      const normalizeDay = (d) => String(d || "").trim().toLowerCase();
      const isDayInList = (list, targetDay) => {
        if (!Array.isArray(list) || list.length === 0) return false;
        const targetNorm = normalizeDay(targetDay);
        const targetShort = targetNorm.slice(0, 3);
        return list.some((item) => {
          const itemNorm = normalizeDay(item);
          return itemNorm === targetNorm || itemNorm === targetShort || itemNorm.slice(0, 3) === targetShort;
        });
      };

      const formatTime12h = (dateObj) => {
        if (!dateObj) return "—";
        const d = new Date(dateObj);
        if (isNaN(d.getTime())) return "—";
        return new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Dhaka",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        }).format(d);
      };

      const empCustomOffDays = Array.isArray(user.rosterOffDays) && user.rosterOffDays.length > 0 ? user.rosterOffDays : null;
      const orgWeekends = Array.isArray(org?.weekendDays) && org.weekendDays.length > 0 ? org.weekendDays : ["Friday"];
      const effectiveOffDays = empCustomOffDays || orgWeekends;

      const nowBdStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka" }).format(new Date());

      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const fullMonthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

      // Calculate expected daily duty hours from running shift
      let shiftDutyMins = 8 * 60; // 8 hours default (480 mins)
      let shiftStartMins = 9 * 60;
      let shiftGrace = 30;

      if (empShift?.startTime && empShift?.endTime) {
        const [sh, sm] = empShift.startTime.split(":").map(Number);
        const [eh, em] = empShift.endTime.split(":").map(Number);
        let diff = (eh * 60 + em) - (sh * 60 + sm);
        if (diff <= 0) diff += 24 * 60; // overnight shift
        shiftDutyMins = Math.max(60, diff);
        shiftStartMins = sh * 60 + sm;
        shiftGrace = empShift.gracePeriodMinutes ?? 30;
      }

      let officeDays = 0;
      let presentCount = 0;
      let absentCount = 0;
      let lateCount = 0;
      let leaveCount = 0;
      let offDayCount = 0;
      let holidayCount = 0;
      let totalWorkMinutes = 0;
      let totalOvertimeMinutes = 0;

      const dailyHistory = [];

      for (let d = new Date(Date.UTC(sY, sM - 1, sD)); d <= new Date(Date.UTC(eY, eM - 1, eD)); d.setUTCDate(d.getUTCDate() + 1)) {
        const dateStr = d.toISOString().split("T")[0];
        const dayName = dayNames[d.getUTCDay()];
        const isHoliday = holidayDateStrs.has(dateStr);
        const isWeekend = isDayInList(effectiveOffDays, dayName);
        const att = attMap.get(dateStr);
        const isFuture = dateStr > nowBdStr;

        const calTime = new Date(dateStr).getTime();
        const hasLeave = leaves.some((l) => {
          const lStart = new Date(l.startDate).getTime();
          const lEnd = new Date(l.endDate).getTime();
          return calTime >= lStart && calTime <= lEnd;
        });

        const [dy, dm, dd] = dateStr.split("-").map(Number);
        const dateFormatted = `${monthNames[dm - 1]} ${String(dd).padStart(2, "0")}`;

        let status = "Absent";
        let checkIn = "—";
        let checkOut = "—";
        let workMins = 0;
        let otMins = 0;

        // Check for manual admin override in punchInAddress
        const hasManualOverride = Boolean(att?.punchInAddress && att.punchInAddress.includes("[OVERRIDE:"));
        const overrideOffDay = Boolean(att?.punchInAddress && att.punchInAddress.includes("[OVERRIDE:OFF_DAY]"));
        const overrideAbsent = Boolean(att?.punchInAddress && att.punchInAddress.includes("[OVERRIDE:ABSENT]"));
        const overrideOffDayDuty = Boolean(att?.punchInAddress && att.punchInAddress.includes("[OVERRIDE:OFF_DAY_DUTY]"));

        // Is this an authorized off day (weekend, official holiday, or approved leave)
        const isOffDay = (isWeekend || isHoliday || hasLeave || overrideOffDay || overrideOffDayDuty) && !overrideAbsent;

        if (!isOffDay && !isFuture) {
          officeDays++;
        }

        if (hasLeave) {
          status = "Leave";
          leaveCount++;
        } else if (overrideAbsent) {
          status = "Absent";
          absentCount++;
          if (att) {
            checkIn = formatTime12h(att.checkInTime);
            checkOut = formatTime12h(att.checkOutTime);
          }
        } else if (overrideOffDay) {
          status = "Off-Day";
          offDayCount++;
          if (att) {
            // If it had real check-in/out times, display them, otherwise leave as —
            if (att.checkOutTime || (att.punchInDeviceType && att.punchInDeviceType !== "MANUAL_ENTRY")) {
              checkIn = formatTime12h(att.checkInTime);
              checkOut = formatTime12h(att.checkOutTime);
              workMins = att.totalWorkMinutes || 0;
              totalWorkMinutes += workMins;
            }
          }
        } else if (att) {
          checkIn = formatTime12h(att.checkInTime);
          checkOut = formatTime12h(att.checkOutTime);
          workMins = att.totalWorkMinutes || 0;

          // Dynamically compute overtime against running shift!
          // Shift end + buffer threshold
          if (att.checkOutTime && empShift?.endTime) {
            const [endH, endM] = empShift.endTime.split(":").map(Number);
            let sEndMins = endH * 60 + endM;
            const threshold = typeof empShift.overtimeThresholdMins === "number" ? empShift.overtimeThresholdMins : 30;
            if (sEndMins < shiftStartMins) sEndMins += 24 * 60;

            const cOut = new Date(att.checkOutTime);
            let cOutMins = ((cOut.getUTCHours() + 6) % 24) * 60 + cOut.getUTCMinutes();
            if (sEndMins >= 24 * 60 && cOutMins < shiftStartMins) cOutMins += 24 * 60;

            if (cOutMins > sEndMins + threshold) {
              otMins = cOutMins - sEndMins;
            } else {
              otMins = 0;
            }
          } else {
            otMins = att.overtimeMinutes || 0;
          }

          totalWorkMinutes += workMins;
          totalOvertimeMinutes += otMins;

          if (isWeekend || overrideOffDay || overrideOffDayDuty) {
            // User requirement: If employee works on off day, explicitly show Off-Day (Duty)
            status = "Off-Day";
            offDayCount++;
          } else if (isHoliday) {
            status = "Holiday";
            holidayCount++;
          } else {
            // Evaluated dynamically against employee's running shift!
            if (user.attendanceExempt || user.role === "OWNER") {
              status = "Present";
            } else if (att.lateReasonStatus === "REJECTED") {
              status = "Absent";
              absentCount++;
            } else {
              const punchIn = new Date(att.checkInTime);
              const punchMins = ((punchIn.getUTCHours() + 6) % 24) * 60 + punchIn.getUTCMinutes();
              const delay = punchMins - shiftStartMins;
              if (delay > shiftGrace) {
                status = "Late";
                lateCount++;
              } else {
                status = "Present";
              }
            }
            if (status !== "Absent") {
              presentCount++;
            }
          }
        } else if (isHoliday) {
          status = "Holiday";
          holidayCount++;
        } else if (isWeekend || overrideOffDay || overrideOffDayDuty) {
          status = "Off-Day";
          offDayCount++;
        } else if (isFuture) {
          status = "Upcoming";
        } else {
          status = "Absent";
          absentCount++;
        }

        dailyHistory.push({
          date: dateStr,
          dateFormatted,
          dayName,
          checkIn,
          checkOut,
          status,
          currentState: att?.currentState || (att ? "CHECKED_OUT" : "NOT_CHECKED_IN"),
          totalBreakMinutes: att?.totalBreakMinutes || 0,
          breaks: att?.breaks
            ? att.breaks.map((b) => ({
                id: b.id,
                breakType: b.breakType,
                startTime: formatTime12h(b.startTime),
                endTime: formatTime12h(b.endTime),
                durationMinutes: b.durationMinutes || 0,
              }))
            : [],
          workMinutes: workMins,
          workHoursFormatted: workMins > 0 ? `${Math.floor(workMins / 60)}h ${workMins % 60}m` : "—",
          overtimeMinutes: otMins,
          holidayName: holidayDateStrs.get(dateStr) || null,
        });
      }

      const [mY, mM] = targetMonth.split("-").map(Number);
      const monthLabel = `${fullMonthNames[mM - 1]} ${mY}`;

      const totalHours = Math.floor(totalWorkMinutes / 60);
      const totalHoursFormatted = totalHours > 0 ? `${totalHours}h` : `${totalWorkMinutes}m`;

      // Calculate Extra / Less Duty Balance for individual report (Option 1: Total Actual Work - Expected Duty)
      // Expected duty = officeDays * shiftDutyMins
      const expectedDutyMinutes = officeDays * shiftDutyMins;
      const balanceMinutes = totalWorkMinutes - expectedDutyMinutes;
      const isNegative = balanceMinutes < 0;
      const absBal = Math.abs(Math.round(balanceMinutes));
      const extraLessBalanceFormatted = `${isNegative ? "-" : "+"}${Math.floor(absBal / 60)}h ${absBal % 60}m`;
      const expectedDutyFormatted = `${Math.floor(expectedDutyMinutes / 60)}h ${expectedDutyMinutes % 60}m`;

      return res.status(200).json({
        success: true,
        employee: {
          id: user.id,
          fullName: user.fullName,
          employeeId: user.employeeId,
          email: user.email,
          avatarUrl: user.avatarUrl,
          department: user.department?.name || "General",
          designation: user.designation?.name || "Staff",
          branch: user.branch?.name || "Head Office",
          shift: empShift ? {
            name: empShift.shiftName,
            startTime: empShift.startTime,
            endTime: empShift.endTime,
          } : null,
          offDays: effectiveOffDays,
        },
        period: {
          startDate,
          endDate,
          month: targetMonth,
          monthLabel,
        },
        stats: {
          presentDays: presentCount,
          absentDays: absentCount,
          lateDays: lateCount,
          leaveDays: leaveCount,
          offDays: offDayCount,
          holidays: holidayCount,
          totalWorkHours: totalHoursFormatted,
          totalWorkMinutes,
          totalOvertimeMinutes,
          expectedDutyMinutes,
          expectedDutyFormatted,
          balanceMinutes,
          extraLessBalanceFormatted,
        },
        dailyHistory,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/attendance/admin/summary-report
  // Generates per-employee aggregated summary for date range (as in user requirement)
  router.get("/admin/summary-report", requireRoles("HR", "ADMIN"), async (req, res, next) => {
    try {
      const { startDate, endDate, departmentId } = req.query;
      if (!startDate || !endDate) {
        return res.status(400).json({ message: "startDate and endDate are required." });
      }

      const organizationId = req.user.organizationId;
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: {
          id: true,
          name: true,
          address: true,
          logoUrl: true,
          ownerEmail: true,
          weekendDays: true,
          hasRosterDuty: true,
          rosterDepartmentIds: true,
        },
      });

      const ownerEmail = (org?.ownerEmail || "").toLowerCase();
      const orgWeekendDays = Array.isArray(org?.weekendDays) && org.weekendDays.length > 0
        ? org.weekendDays
        : ["Friday"];
      const hasRoster = Boolean(org?.hasRosterDuty);
      const rosterDeptIds = Array.isArray(org?.rosterDepartmentIds) ? org.rosterDepartmentIds : [];

      // 1. Fetch all applicable employees in organization
      const employees = await prisma.user.findMany({
        where: {
          organizationId,
          role: { not: "OWNER" },
          ...(ownerEmail ? { email: { not: ownerEmail } } : {}),
          ...(departmentId && departmentId !== "ALL" ? { departmentId } : {}),
          isDeleted: false,
        },
        select: {
          id: true,
          employeeId: true,
          fullName: true,
          status: true,
          departmentId: true,
          department: { select: { id: true, name: true } },
          designation: { select: { id: true, name: true } },
          shiftId: true,
          shift: { select: { id: true, shiftName: true, startTime: true, endTime: true, gracePeriodMinutes: true } },
          branch: { select: { id: true, name: true } },
          rosterOffDays: true,
        },
        orderBy: [{ department: { name: "asc" } }, { employeeId: "asc" }],
      });

      // 2. Fetch default shift for standard duration calculation
      const defaultShift = await prisma.officeSetting.findFirst({
        where: { organizationId, isDefault: true },
      }) || await prisma.officeSetting.findFirst({ where: { organizationId } });

      const [sY, sM, sD] = startDate.split("-").map(Number);
      const [eY, eM, eD] = endDate.split("-").map(Number);
      const startUtc = new Date(Date.UTC(sY, sM - 1, sD, 0, 0, 0, 0));
      const endUtc = new Date(Date.UTC(eY, eM - 1, eD, 23, 59, 59, 999));

      // Generate all calendar day strings in the range [YYYY-MM-DD] using UTC to prevent timezone drift
      const calendarDates = [];
      const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      for (let d = new Date(Date.UTC(sY, sM - 1, sD)); d <= new Date(Date.UTC(eY, eM - 1, eD)); d.setUTCDate(d.getUTCDate() + 1)) {
        calendarDates.push({
          dateStr: d.toISOString().split("T")[0],
          dayName: dayNames[d.getUTCDay()],
        });
      }

      // 3. Fetch all attendance records in range
      const attendances = await prisma.attendance.findMany({
        where: {
          organizationId,
          date: {
            gte: startUtc,
            lte: endUtc,
          },
        },
        select: {
          userId: true,
          date: true,
          checkInTime: true,
          checkOutTime: true,
          status: true,
          totalWorkMinutes: true,
          overtimeMinutes: true,
        },
      });

      // 4. Fetch approved leaves in range
      const leaves = await prisma.leaveRequest.findMany({
        where: {
          organizationId,
          status: "APPROVED",
          startDate: { lte: endUtc },
          endDate: { gte: startUtc },
        },
        select: {
          userId: true,
          startDate: true,
          endDate: true,
        },
      });

      // 4.1 Fetch official holidays in range
      const holidays = await prisma.holiday.findMany({
        where: {
          organizationId,
          fromDate: { lte: endUtc },
          toDate: { gte: startUtc },
        },
        select: {
          fromDate: true,
          toDate: true,
          title: true,
        },
      });
      const holidayDateStrs = new Set();
      holidays.forEach((h) => {
        const hStart = new Date(h.fromDate);
        const hEnd = new Date(h.toDate);
        for (let d = new Date(hStart); d <= hEnd; d.setUTCDate(d.getUTCDate() + 1)) {
          holidayDateStrs.add(d.toISOString().split("T")[0]);
        }
      });

      // Group attendances by userId -> date string (YYYY-MM-DD)
      const userAttMap = new Map();
      attendances.forEach((att) => {
        if (!userAttMap.has(att.userId)) userAttMap.set(att.userId, new Map());
        const dStr = new Date(att.date).toISOString().split("T")[0];
        userAttMap.get(att.userId).set(dStr, att);
      });

      // Helper function to format minutes as HH:MM
      const formatHoursMins = (totalMinutes) => {
        const isNegative = totalMinutes < 0;
        const absMins = Math.abs(Math.round(totalMinutes));
        const h = Math.floor(absMins / 60);
        const m = absMins % 60;
        return `${isNegative ? "-" : ""}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      };

      // Helper to match day names case-insensitively and handle short/full names (e.g. "Sat" vs "Saturday")
      const normalizeDay = (d) => String(d || "").trim().toLowerCase();
      const isDayInList = (list, targetDay) => {
        if (!Array.isArray(list) || list.length === 0) return false;
        const targetNorm = normalizeDay(targetDay);
        const targetShort = targetNorm.slice(0, 3);
        return list.some((item) => {
          const itemNorm = normalizeDay(item);
          return itemNorm === targetNorm || itemNorm === targetShort || itemNorm.slice(0, 3) === targetShort;
        });
      };

      // 5. Aggregate summary per employee
      const summaryRows = employees.map((emp, index) => {
        const isRosterEmp = hasRoster && emp.departmentId && rosterDeptIds.includes(emp.departmentId);
        const empCustomOffDays = Array.isArray(emp.rosterOffDays) && emp.rosterOffDays.length > 0
          ? emp.rosterOffDays
          : null;
        const orgWeekends = Array.isArray(orgWeekendDays) && orgWeekendDays.length > 0
          ? orgWeekendDays
          : ["Friday"];

        // Effective off-days: If employee has custom designated off-days assigned, always respect them; otherwise fallback to organization weekends
        const effectiveOffDays = empCustomOffDays || orgWeekends;

        const userAtts = userAttMap.get(emp.id) || new Map();

        // Calculate expected daily duty hours from shift
        const empShift = emp.shift || defaultShift;
        let shiftDutyMins = 8 * 60; // 8 hours default (480 mins)
        let shiftStartMins = 9 * 60;
        let shiftGrace = 30;

        if (empShift?.startTime && empShift?.endTime) {
          const [sh, sm] = empShift.startTime.split(":").map(Number);
          const [eh, em] = empShift.endTime.split(":").map(Number);
          let diff = (eh * 60 + em) - (sh * 60 + sm);
          if (diff <= 0) diff += 24 * 60; // overnight shift
          shiftDutyMins = Math.max(60, diff); // Total shift duty duration as configured
          shiftStartMins = sh * 60 + sm;
          shiftGrace = empShift.gracePeriodMinutes || 30;
        }

        let officeDays = 0;
        let presentCount = 0;
        let lateCount = 0;
        let leaveCount = 0;
        let absentCount = 0;
        let extremeDelayCount = 0;
        let totalDelayMinutes = 0;
        let actualDutyMinutes = 0;
        let expectedDutyMinutes = 0;
        let overtimeDutyMinutes = 0;
        let overtimeDaysCount = 0;

        // Check each calendar day
        for (const cal of calendarDates) {
          const isHoliday = holidayDateStrs.has(cal.dateStr);
          const isWeekend = isDayInList(effectiveOffDays, cal.dayName);

          // Check if employee had approved leave on this date
          const calTime = new Date(cal.dateStr).getTime();
          const hasLeave = leaves.some((l) => {
            if (l.userId !== emp.id) return false;
            const lStart = new Date(l.startDate).getTime();
            const lEnd = new Date(l.endDate).getTime();
            return calTime >= lStart && calTime <= lEnd;
          });

          // Designated off-day, holiday, or approved leave date: employee is authorized off, so don't count towards office days
          const isOffDay = isWeekend || isHoliday || hasLeave;

          if (!isOffDay) {
            officeDays++;
          }

          const attRecord = userAtts.get(cal.dateStr);

          if (hasLeave) {
            leaveCount++;
          } else if (attRecord) {
            // Actual work minutes
            const workMins = attRecord.checkOutTime ? (attRecord.totalWorkMinutes || 0) : 0;
            actualDutyMinutes += workMins;

            // Dynamically compute Overtime based on running shift!
            let otMins = 0;
            if (attRecord.checkOutTime && empShift?.endTime) {
              const [endH, endM] = empShift.endTime.split(":").map(Number);
              let sEndMins = endH * 60 + endM;
              const threshold = typeof empShift.overtimeThresholdMins === "number" ? empShift.overtimeThresholdMins : 30;
              if (sEndMins < shiftStartMins) sEndMins += 24 * 60;

              const cOut = new Date(attRecord.checkOutTime);
              let cOutMins = ((cOut.getUTCHours() + 6) % 24) * 60 + cOut.getUTCMinutes();
              if (sEndMins >= 24 * 60 && cOutMins < shiftStartMins) cOutMins += 24 * 60;

              if (cOutMins > sEndMins + threshold) {
                otMins = cOutMins - sEndMins;
              }
            } else {
              otMins = attRecord.overtimeMinutes || 0;
            }

            if (otMins > 0) {
              overtimeDutyMinutes += otMins;
              overtimeDaysCount++;
            }

            if (isWeekend) {
              // Working on designated off-day: not late, but accounted as duty
            } else if (isHoliday) {
              // Working on holiday
            } else {
              // Evaluated dynamically against employee's active shift
              if (emp.attendanceExempt || emp.role === "OWNER") {
                presentCount++;
              } else if (attRecord.lateReasonStatus === "REJECTED") {
                absentCount++;
              } else {
                presentCount++;
                if (attRecord.checkInTime) {
                  const punchIn = new Date(attRecord.checkInTime);
                  const punchMins = ((punchIn.getUTCHours() + 6) % 24) * 60 + punchIn.getUTCMinutes();
                  const delay = punchMins - shiftStartMins;
                  if (delay > shiftGrace) {
                    lateCount++;
                    totalDelayMinutes += delay;
                    // If delay exceeds 60 minutes beyond grace period, catalog as Extreme Delay
                    if (delay >= shiftGrace + 60) {
                      extremeDelayCount++;
                    }
                  }
                }
              }
            }
          } else {
            // Not on leave, no attendance record: only mark absent on mandatory working office days
            if (!isOffDay) {
              absentCount++;
            }
          }
        }

        // Expected duty minutes = officeDays * shiftDutyMins
        expectedDutyMinutes = officeDays * shiftDutyMins;

        // Extra / Less Duty Balance in minutes = actualDutyMinutes - expectedDutyMinutes (Option 1)
        const balanceMinutes = actualDutyMinutes - expectedDutyMinutes;

        return {
          serialNo: index + 1,
          employeeId: emp.employeeId,
          employeeName: emp.fullName,
          status: emp.status || "ACTIVE",
          departmentName: emp.department?.name || "General",
          designation: emp.designation?.name || "Staff",
          branchName: emp.branch?.name || "Head Office",
          isRoster: isRosterEmp,
          officeDays,
          absent: absentCount,
          leave: leaveCount,
          present: presentCount,
          late: lateCount,
          extremeDelay: extremeDelayCount,
          totalDelayFormatted: formatHoursMins(totalDelayMinutes),
          totalDelayMinutes,
          overtimeDays: overtimeDaysCount,
          expectedDutyFormatted: formatHoursMins(expectedDutyMinutes),
          expectedDutyMinutes,
          actualDutyFormatted: formatHoursMins(actualDutyMinutes),
          actualDutyMinutes,
          overtimeFormatted: formatHoursMins(overtimeDutyMinutes),
          overtimeMinutes: overtimeDutyMinutes,
          extraLessBalanceFormatted: formatHoursMins(balanceMinutes),
          balanceMinutes,
        };
      });

      return res.status(200).json({
        organization: {
          name: org?.name || "",
          address: org?.address || "",
          logoUrl: org?.logoUrl || null,
        },
        reportPeriod: {
          startDate,
          endDate,
        },
        summary: summaryRows,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createAttendanceRouter };
