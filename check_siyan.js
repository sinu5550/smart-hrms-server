const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
async function run() {
  const siyan = await prisma.user.findFirst({ where: { employeeId: "EKH26004" } });
  console.log("User:", siyan?.fullName, siyan?.id);
  const att = await prisma.attendance.findMany({ where: { userId: siyan?.id } });
  console.log("Siyan Attendance:", JSON.stringify(att, null, 2));
  const punches = await prisma.biometricRawLog.findMany({ where: { employeeId: "EKH26004" } });
  console.log("Siyan Raw Punches:", JSON.stringify(punches, null, 2));
}
run().catch(console.error).finally(() => prisma.$disconnect());
