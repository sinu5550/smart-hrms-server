const express = require("express");
const { authenticateToken, requireRoles } = require("../middleware");

function createDevicesRouter(prisma) {
  const router = express.Router();

  // GET /api/devices (Admin, HR)
  router.get("/", authenticateToken, requireRoles("ADMIN", "HR"), async (req, res, next) => {
    try {
      const devices = await prisma.biometricDevice.findMany({
        where: { organizationId: req.user.organizationId },
        orderBy: { createdAt: "desc" },
      });
      return res.status(200).json(devices);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/devices (Admin)
  router.post("/", authenticateToken, requireRoles("ADMIN"), async (req, res, next) => {
    try {
      const dto = req.body || {};
      const organizationId = req.user.organizationId;

      const existing = await prisma.biometricDevice.findFirst({
        where: { organizationId, deviceSerialNumber: dto.deviceSerialNumber },
      });
      if (existing) {
        return res.status(400).json({
          message: `Device with serial number "${dto.deviceSerialNumber}" is already registered.`,
        });
      }

      const created = await prisma.biometricDevice.create({
        data: {
          organizationId,
          deviceName: dto.deviceName,
          deviceSerialNumber: dto.deviceSerialNumber,
          deviceModel: dto.deviceModel || "ZKTeco / ADMS Standalone",
          ipAddress: dto.ipAddress || null,
          port: dto.port || 4370,
          locationName: dto.locationName || "Main Entrance Gate",
          status: "ONLINE",
          lastHeartbeat: new Date(),
        },
      });

      return res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/devices/:id (Admin)
  router.delete("/:id", authenticateToken, requireRoles("ADMIN"), async (req, res, next) => {
    try {
      const { id } = req.params;
      const organizationId = req.user.organizationId;

      const device = await prisma.biometricDevice.findFirst({
        where: { id, organizationId },
      });
      if (!device) {
        return res.status(404).json({ message: "Device not found." });
      }

      const deleted = await prisma.biometricDevice.delete({ where: { id } });
      return res.status(200).json(deleted);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/devices/logs (Admin, HR)
  router.get("/logs", authenticateToken, requireRoles("ADMIN", "HR"), async (req, res, next) => {
    try {
      const logs = await prisma.biometricRawLog.findMany({
        where: { organizationId: req.user.organizationId },
        orderBy: { punchTime: "desc" },
        take: 50,
        include: {
          device: { select: { deviceName: true, locationName: true } },
        },
      });
      return res.status(200).json(logs);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/devices/webhook/push-log (Public hardware push webhook)
  router.post("/webhook/push-log", async (req, res, next) => {
    try {
      const dto = req.body || {};

      // 1. Locate device
      const device = await prisma.biometricDevice.findFirst({
        where: { deviceSerialNumber: dto.deviceSerialNumber },
      });

      if (!device || !device.organizationId) {
        return res.status(404).json({
          message: `Unregistered hardware device serial: ${dto.deviceSerialNumber}`,
        });
      }

      // 2. Find user in the same organization
      const user = await prisma.user.findFirst({
        where: {
          organizationId: device.organizationId,
          employeeId: dto.employeeId,
        },
      });

      if (!user) {
        return res.status(404).json({
          message: `Employee ID "${dto.employeeId}" not found in workspace.`,
        });
      }

      const punchDate = new Date(dto.punchTime);
      const utcMidnightToday = new Date(
        Date.UTC(punchDate.getUTCFullYear(), punchDate.getUTCMonth(), punchDate.getUTCDate())
      );

      // 3. Record raw punch
      await prisma.biometricRawLog.create({
        data: {
          organizationId: device.organizationId,
          deviceId: device.id,
          deviceSerialNumber: dto.deviceSerialNumber,
          employeeId: dto.employeeId,
          punchTime: punchDate,
          punchType: dto.punchType || "CHECK_IN",
          verificationMode: dto.verificationMode || "FINGERPRINT",
          syncStatus: "PROCESSED",
        },
      });

      // 4. Update device heartbeat & sync counter
      await prisma.biometricDevice.update({
        where: { id: device.id },
        data: {
          lastHeartbeat: new Date(),
          totalLogsSynced: { increment: 1 },
          status: "ONLINE",
        },
      });

      // 5. Auto sync to Attendance ledger
      const existingAttendance = await prisma.attendance.findUnique({
        where: {
          userId_date: {
            userId: user.id,
            date: utcMidnightToday,
          },
        },
      });

      if (!existingAttendance) {
        await prisma.attendance.create({
          data: {
            organizationId: device.organizationId,
            userId: user.id,
            date: utcMidnightToday,
            checkInTime: punchDate,
            currentState: "CHECKED_IN",
            status: "PRESENT",
            ipAddress: device.ipAddress || "BIOMETRIC_HARDWARE",
            punchInDeviceType: "BIOMETRIC_TERMINAL",
            punchInAddress: device.locationName,
          },
        });
      } else if (existingAttendance.currentState !== "CHECKED_OUT") {
        const elapsedMinutes = Math.max(
          0,
          Math.round((punchDate.getTime() - existingAttendance.checkInTime.getTime()) / (1000 * 60))
        );
        const totalWorkMinutes = Math.max(
          0,
          elapsedMinutes - existingAttendance.totalBreakMinutes
        );

        await prisma.attendance.update({
          where: { id: existingAttendance.id },
          data: {
            checkOutTime: punchDate,
            currentState: "CHECKED_OUT",
            totalWorkMinutes,
            punchOutAddress: device.locationName,
          },
        });
      }

      return res.status(200).json({ success: true, message: "Punch log processed successfully" });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createDevicesRouter };
