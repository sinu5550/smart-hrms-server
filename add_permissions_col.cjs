require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function addPermissions() {
  try {
    console.log("Adding permissions column to hrms.users table...");
    await prisma.$executeRawUnsafe(`
      ALTER TABLE hrms.users 
      ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '[]'::jsonb;
    `);
    console.log("Successfully added permissions column to hrms.users!");
  } catch (err) {
    console.error("Migration error:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

addPermissions();
