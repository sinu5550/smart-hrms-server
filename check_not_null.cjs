require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function checkNullable() {
  try {
    const cols = await prisma.$queryRawUnsafe(`
      SELECT column_name, is_nullable 
      FROM information_schema.columns 
      WHERE table_schema = 'hrms' AND table_name = 'users' AND is_nullable = 'NO';
    `);
    console.log("NOT_NULL_COLUMNS_USERS:", JSON.stringify(cols, null, 2));
  } catch (err) {
    console.error("ERROR:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkNullable();
