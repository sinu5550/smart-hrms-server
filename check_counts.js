const { prisma } = require("./src/prisma");

async function check() {
  const users = await prisma.user.groupBy({
    by: ["status"],
    _count: { id: true },
    where: { isDeleted: false },
  });
  console.log("Users by status:", users);

  const configs = await prisma.$queryRawUnsafe(
    "SELECT id, organization_id, name, code, count_in_attendance, is_default FROM hrms.employment_status_configs"
  );
  console.log("Configs:", configs);

  const allActiveUsers = await prisma.user.findMany({
    where: { isDeleted: false },
    select: { id: true, fullName: true, status: true, email: true },
  });
  console.log("All non-deleted users count:", allActiveUsers.length);
  console.log("Users list:", allActiveUsers);

  await prisma.$disconnect();
}

check();

