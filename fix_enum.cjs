require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function fixEnum() {
  try {
    await prisma.$executeRawUnsafe(`ALTER TYPE hrms."Role" ADD VALUE IF NOT EXISTS 'PLATFORM_ADMIN';`);
    console.log("Successfully added PLATFORM_ADMIN to Role enum!");
  } catch (err) {
    console.error("Error updating enum:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

fixEnum();
