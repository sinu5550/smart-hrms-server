const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function inspectAll() {
  const orgs = await prisma.organization.findMany();
  console.log("ALL ORGS:", orgs.map(o => ({ id: o.id, name: o.name, ownerEmail: o.ownerEmail })));
  
  const allUsers = await prisma.user.findMany({
    select: { id: true, employeeId: true, fullName: true, email: true, role: true, organizationId: true }
  });
  console.log(`ALL USERS IN DB (${allUsers.length}):`);
  console.table(allUsers);
}

inspectAll().then(() => prisma.$disconnect()).catch(console.error);
