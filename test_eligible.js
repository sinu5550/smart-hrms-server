const { prisma } = require("./src/prisma");

async function check() {
  const orgId = "724cc8c3-6b21-4e21-8fb2-e6060931d995";
  const statusConfigs = await prisma.$queryRawUnsafe(
    'SELECT code, count_in_attendance as "countInAttendance" FROM hrms.employment_status_configs WHERE organization_id = $1::uuid',
    orgId
  );
  console.log("Configs:", statusConfigs);
  const eligible = statusConfigs.filter((s) => s.countInAttendance).map((s) => s.code);
  console.log("Eligible codes:", eligible);

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { ownerEmail: true },
  });
  console.log("Owner email:", org?.ownerEmail);

  const emps = await prisma.user.findMany({
    where: {
      organizationId: orgId,
      isDeleted: false,
      status: { in: eligible },
      email: { not: org.ownerEmail.toLowerCase() },
    },
    select: { id: true, fullName: true, status: true, email: true },
  });
  console.log("Eligible emps count:", emps.length);
  console.log(emps);

  await prisma.$disconnect();
}

check();

