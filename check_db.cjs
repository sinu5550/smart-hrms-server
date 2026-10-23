require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function check() {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        employeeId: true,
        role: true,
        organizationId: true
      }
    });
    console.log("ALL_USERS:", JSON.stringify(users, null, 2));

    const orgs = await prisma.organization.findMany({
      select: { id: true, name: true, employeePrefix: true }
    });
    console.log("ALL_ORGS:", JSON.stringify(orgs, null, 2));
  } catch (err) {
    console.error("DB_ERROR:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

check();
