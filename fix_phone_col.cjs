require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function fixUserPhoneColumn() {
  try {
    console.log("Altering hrms.users.phone to be nullable (DROP NOT NULL)...");
    await prisma.$executeRawUnsafe(`ALTER TABLE hrms.users ALTER COLUMN phone DROP NOT NULL;`);
    console.log("Successfully altered hrms.users.phone to be NULLABLE!");
  } catch (err) {
    console.error("Error altering column:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

fixUserPhoneColumn();
