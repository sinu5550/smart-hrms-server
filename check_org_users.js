const { prisma } = require("./src/prisma");

async function checkOrg() {
  const orgs = await prisma.organization.findMany();
  console.log("Orgs:", orgs.map(o => ({ id: o.id, name: o.name, ownerEmail: o.ownerEmail })));

  for (const org of orgs) {
    const users = await prisma.user.findMany({
      where: { organizationId: org.id, isDeleted: false },
      select: { id: true, fullName: true, status: true, email: true }
    });
    console.log(`\n--- Org: ${org.name} (${org.id}) [Owner: ${org.ownerEmail}] ---`);
    console.log("Total users in this org:", users.length);
    const byStatus = {};
    users.forEach(u => {
      byStatus[u.status] = (byStatus[u.status] || 0) + 1;
    });
    console.log("By status:", byStatus);
  }

  await prisma.$disconnect();
}

checkOrg();

