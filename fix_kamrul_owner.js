const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const bcrypt = require("bcrypt");

async function fixOwnerAndCreateKamrul() {
  const orgId = "fd67f3e0-beb8-4fbf-a4b0-3fd2caeb4bef";
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
  });
  console.log("Current Org:", org?.name, "ownerEmail:", org?.ownerEmail);

  // 1. Check Owner record
  const owner = await prisma.user.findFirst({
    where: { organizationId: orgId, role: "OWNER" },
  });
  console.log("Current Owner User:", {
    id: owner?.id,
    employeeId: owner?.employeeId,
    fullName: owner?.fullName,
    email: owner?.email,
    role: owner?.role
  });

  // 2. Ensure owner name is Ahmed Siyan (or user's preferred name)
  if (owner && owner.fullName !== "Ahmed Siyan") {
    await prisma.user.update({
      where: { id: owner.id },
      data: { fullName: "Ahmed Siyan" },
    });
    console.log("Restored Owner fullName to 'Ahmed Siyan'");
  }

  // 3. Check if KAMRUL exists as a separate EMPLOYEE record for terminal ID 3
  const kamrulFormattedId = "EKH-26-0003";
  let kamrul = await prisma.user.findFirst({
    where: {
      organizationId: orgId,
      OR: [
        { employeeId: kamrulFormattedId },
        { employeeId: "3" },
        { employeeId: "EKH26003" },
        { fullName: { contains: "KAMRUL", mode: "insensitive" }, role: "EMPLOYEE" },
      ],
    },
  });

  if (!kamrul) {
    const defaultPasswordHash = await bcrypt.hash("12345678", 10);
    kamrul = await prisma.user.create({
      data: {
        organizationId: orgId,
        employeeId: kamrulFormattedId,
        fullName: "KAMRUL",
        email: "3_fd67@company.local",
        passwordHash: defaultPasswordHash,
        role: "EMPLOYEE",
        status: "ACTIVE",
        mustChangePassword: true,
        permissions: ["bio:fingerprint", "bio:face"],
      },
    });
    console.log("Created separate Employee record for KAMRUL:", kamrul);
  } else {
    console.log("KAMRUL already exists as employee:", kamrul.id, kamrul.employeeId, kamrul.fullName);
  }

  // 4. Check all attendance and raw logs currently linked to Owner by mistake
  const rawLogsCount = await prisma.biometricRawLog.count({
    where: { organizationId: orgId, employeeId: "3" },
  });
  console.log("Raw logs with employeeId '3':", rawLogsCount);

  // If attendance for today was recorded for Owner ID instead of Kamrul
  const today = new Date().toISOString().split("T")[0];
  const ownerTodayAttendance = await prisma.attendance.findFirst({
    where: { userId: owner.id, date: today },
  });
  if (ownerTodayAttendance) {
    console.log("Found today's attendance under Owner! Transferring to KAMRUL...");
    await prisma.attendance.update({
      where: { id: ownerTodayAttendance.id },
      data: { userId: kamrul.id },
    });
    console.log("Successfully reassigned today's attendance to KAMRUL.");
  }
}

fixOwnerAndCreateKamrul().then(() => prisma.$disconnect()).catch(console.error);
