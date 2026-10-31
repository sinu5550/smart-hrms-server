const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
async function run() {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { fullName: { contains: "Intisar", mode: "insensitive" } },
        { fullName: { contains: "Siyan", mode: "insensitive" } },
        { employeeId: { contains: "26004" } },
      ]
    },
    select: { id: true, employeeId: true, fullName: true, email: true, organizationId: true }
  });
  console.log("MATCHED USERS:", JSON.stringify(users, null, 2));

  const allInOrg = await prisma.user.findMany({
    take: 10,
    select: { id: true, employeeId: true, fullName: true }
  });
  console.log("SAMPLE USERS:", JSON.stringify(allInOrg, null, 2));
}
run().catch(console.error).finally(() => prisma.$disconnect());
