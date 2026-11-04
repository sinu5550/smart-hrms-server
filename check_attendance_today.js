const { prisma } = require("./src/prisma");

async function checkAttendanceToday() {
  const orgId = "724cc8c3-6b21-4e21-8fb2-e6060931d995";
  const today = new Date().toISOString().slice(0, 10);
  const dateObj = new Date(today);

  const records = await prisma.attendance.findMany({
    where: {
      organizationId: orgId,
      date: dateObj,
    },
    include: {
      user: {
        select: { id: true, fullName: true, status: true, email: true },
      },
    },
  });

  console.log("Records found for today:", records.length);
  console.log(
    records.map((r) => ({
      userId: r.userId,
      name: r.user?.fullName,
      status: r.user?.status,
      email: r.user?.email,
      attStatus: r.status,
    }))
  );

  const configs = await prisma.$queryRawUnsafe(
    "SELECT * FROM hrms.employment_status_configs WHERE organization_id = $1::uuid",
    orgId
  );
  console.log("Configs for org:", configs);

  const orgUsers = await prisma.user.findMany({
    where: { organizationId: orgId, isDeleted: false },
    select: { id: true, fullName: true, status: true, email: true },
  });
  console.log("Total org non-deleted users:", orgUsers.length);
  console.log(orgUsers);

  await prisma.$disconnect();
}

checkAttendanceToday();

