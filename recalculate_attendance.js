const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function recalculateTodayAttendance() {
  const orgId = "fd67f3e0-beb8-4fbf-a4b0-3fd2caeb4bef";
  const today = new Date();
  const dayUtcMidnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const attendances = await prisma.attendance.findMany({
    where: { organizationId: orgId, date: dayUtcMidnight },
    include: {
      user: {
        select: {
          id: true,
          employeeId: true,
          fullName: true,
          role: true,
          attendanceExempt: true,
          shiftId: true,
          shift: true,
        },
      },
    },
  });

  console.log(`Found ${attendances.length} attendance records for today (${dayUtcMidnight.toISOString().split("T")[0]}):`);

  // Default shift for org
  const defaultShift = await prisma.officeSetting.findFirst({
    where: { organizationId: orgId, isDefault: true },
  });
  console.log("Org Default Shift:", defaultShift?.shiftName, defaultShift?.startTime, "Grace:", defaultShift?.gracePeriodMinutes, "mins");

  for (const att of attendances) {
    if (!att.checkInTime) continue;

    const user = att.user;
    if (user.role === "OWNER" || user.attendanceExempt) {
      if (att.status !== "PRESENT") {
        await prisma.attendance.update({ where: { id: att.id }, data: { status: "PRESENT" } });
      }
      console.log(`- ${user.fullName} (${user.employeeId}): EXEMPT/OWNER -> PRESENT`);
      continue;
    }

    const shift = user.shift || defaultShift;
    const startTimeStr = shift?.startTime || "09:00";
    const graceMinutes = typeof shift?.gracePeriodMinutes === "number" ? shift.gracePeriodMinutes : 30;
    const [startH, startM] = startTimeStr.split(":").map(Number);
    const cutoffMinutes = startH * 60 + startM + graceMinutes;

    // Local checkin time (+06:00)
    const localCheckIn = new Date(att.checkInTime.getTime() + 6 * 60 * 60 * 1000);
    const checkInMinutes = localCheckIn.getUTCHours() * 60 + localCheckIn.getUTCMinutes();

    const expectedStatus = checkInMinutes > cutoffMinutes ? "LATE" : "PRESENT";
    const checkInFormatted = `${String(localCheckIn.getUTCHours()).padStart(2, "0")}:${String(localCheckIn.getUTCMinutes()).padStart(2, "0")}`;

    if (att.status !== expectedStatus) {
      await prisma.attendance.update({
        where: { id: att.id },
        data: { status: expectedStatus },
      });
      console.log(`* UPDATED ${user.fullName} (${user.employeeId}): Check-in ${checkInFormatted} (Cutoff: ${startTimeStr} + ${graceMinutes}m = ${Math.floor(cutoffMinutes/60)}:${cutoffMinutes%60}) -> Old: ${att.status} => New: ${expectedStatus}`);
    } else {
      console.log(`- OK ${user.fullName} (${user.employeeId}): Check-in ${checkInFormatted} -> ${att.status}`);
    }
  }
}

recalculateTodayAttendance().then(() => prisma.$disconnect()).catch(console.error);
