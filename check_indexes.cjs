require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function run() {
  try {
    const indexes = await prisma.$queryRawUnsafe(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'users' AND schemaname = 'hrms';
    `);
    console.log("Indexes on hrms.users:", JSON.stringify(indexes, null, 2));

    const existingUsers = await prisma.user.findMany({
      select: { id: true, email: true, employeeId: true, organizationId: true }
    });
    console.log("All existing users:", existingUsers);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
