const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function inspect() {
  const org = await prisma.organization.findFirst();
  console.log("ORGANIZATION:", { id: org?.id, name: org?.name, ownerEmail: org?.ownerEmail });
  const users = await prisma.user.findMany({
    where: { organizationId: org?.id },
    select: { id: true, employeeId: true, fullName: true, email: true, role: true, isDeleted: true }
  });
  console.log(`USERS IN ORG (${users.length}):`);
  console.table(users);
}

inspect().then(() => prisma.$disconnect()).catch(console.error);
