const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function checkShifts() {
  const shifts = await prisma.officeSetting.findMany();
  console.log("OFFICE SHIFTS:", JSON.stringify(shifts, null, 2));
  
  const usersWithShift = await prisma.user.findMany({
    select: { id: true, employeeId: true, fullName: true, shiftId: true, shift: true }
  });
  console.log("USERS AND SHIFTS:");
  console.table(usersWithShift.map(u => ({
    employeeId: u.employeeId,
    name: u.fullName,
    shiftName: u.shift?.shiftName || "Default",
    startTime: u.shift?.startTime || "N/A",
    gracePeriod: u.shift?.gracePeriodMinutes ?? "N/A"
  })));
}

checkShifts().then(() => prisma.$disconnect()).catch(console.error);
