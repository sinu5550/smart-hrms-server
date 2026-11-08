const express = require("express");
const crypto = require("crypto");
const { authenticateToken, requireRoles, officeIpGuard, resolveClientIp } = require("../middleware");

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
      const requiredDutyMinutes = Math.max(60, shiftEndMins - shiftStartMins);

      // Rule A: Employee MUST fulfill required duty duration first!
      if (typeof totalWorkMinutes === "number" && totalWorkMinutes < requiredDutyMinutes) {
        return 0;
      }

      // Rule B: Overtime calculated only for duration beyond shift duty hours minus threshold buffer
      if (typeof totalWorkMinutes === "number") {
        const extraMinutes = totalWorkMinutes - requiredDutyMinutes;
        // If extra work exceeds buffer (e.g. 40 mins extra with 30 min buffer), overtime is 40 - 30 = 10 mins!
        if (extraMinutes > thresholdMins) {
          return extraMinutes - thresholdMins;
        }
        return 0;
      }

      const localCheckOut = new Date(checkOutDate.getTime() + 6 * 60 * 60 * 1000);
      const checkOutMins = localCheckOut.getUTCHours() * 60 + localCheckOut.getUTCMinutes();
      if (checkOutMins > shiftEndMins + thresholdMins) {
        return checkOutMins - shiftEndMins - thresholdMins;
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
      const attendance = await prisma.attendance.findUnique({
        where: { userId_date: { userId: req.user.userId, date: today } },
        include: {
          breaks: {
            orderBy: { startTime: "desc" },
          },
        },
      });

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

      if (!attendance) {
        return res.status(200).json({
          checkedIn: false,
          checkedOut: false,
          attendance: null,
          isExempt,
          rosterDetails,
        });
      }

      return res.status(200).json({
        checkedIn: true,
        checkedOut: attendance.currentState === "CHECKED_OUT",
        attendance,
        isExempt,
        rosterDetails,
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
        const today = await getOrganizationAttendanceDate(req.user.organizationId);
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

          return tx.attendance.update({
            where: { id: attendance.id },
            data: {
              checkOutTime: now,
              currentState: "CHECKED_OUT",
              totalWorkMinutes,
              overtimeMinutes,
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

      return res.status(200).json(records);
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

      // 5. Aggregate summary per employee
      const summaryRows = employees.map((emp, index) => {
        const isRosterEmp = hasRoster && emp.departmentId && rosterDeptIds.includes(emp.departmentId);
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
          const empRosterOffDays = Array.isArray(emp.rosterOffDays) ? emp.rosterOffDays : [];
          const isWeekend = isRosterEmp ? empRosterOffDays.includes(cal.dayName) : orgWeekendDays.includes(cal.dayName);

          // If day is a weekend for standard employee, don't count towards standard working office days unless they worked
          if (!isWeekend) {
            officeDays++;
          }

          // Check if employee had approved leave on this date
          const calTime = new Date(cal.dateStr).getTime();
          const hasLeave = leaves.some((l) => {
            if (l.userId !== emp.id) return false;
            const lStart = new Date(l.startDate).getTime();
            const lEnd = new Date(l.endDate).getTime();
            return calTime >= lStart && calTime <= lEnd;
          });

          const attRecord = userAtts.get(cal.dateStr);

          if (hasLeave) {
            leaveCount++;
          } else if (attRecord) {
            presentCount++;
            if (attRecord.status === "LATE") {
              lateCount++;
            }

            // Actual work minutes
            const workMins = attRecord.checkOutTime ? (attRecord.totalWorkMinutes || 0) : 0;
            actualDutyMinutes += workMins;

            // Overtime
            const otMins = attRecord.overtimeMinutes || 0;
            if (otMins > 0) {
              overtimeDutyMinutes += otMins;
              overtimeDaysCount++;
            }

            // Delay computation
            if (attRecord.checkInTime) {
              const punchIn = new Date(attRecord.checkInTime);
              const punchMins = ((punchIn.getUTCHours() + 6) % 24) * 60 + punchIn.getUTCMinutes();
              const delay = punchMins - shiftStartMins;
              if (delay > shiftGrace) {
                totalDelayMinutes += delay;
                // If delay exceeds 60 minutes beyond grace period, catalog as Extreme Delay
                if (delay >= shiftGrace + 60) {
                  extremeDelayCount++;
                }
              }
            }
          } else {
            // Not on leave, no attendance record
            if (!isWeekend) {
              absentCount++;
            }
          }
        }

        // Expected duty minutes = officeDays * shiftDutyMins
        expectedDutyMinutes = officeDays * shiftDutyMins;

        // Extra / Less Duty Balance in minutes = actualDutyMinutes + overtimeDutyMinutes - expectedDutyMinutes
        const balanceMinutes = actualDutyMinutes + overtimeDutyMinutes - expectedDutyMinutes;

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
