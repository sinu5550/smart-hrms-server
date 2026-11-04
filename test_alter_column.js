const { prisma } = require("./src/prisma");

async function checkCast() {
  try {
    // Check if we can alter column to TEXT
    await prisma.$executeRawUnsafe(
      "ALTER TABLE hrms.users ALTER COLUMN status TYPE TEXT USING status::text"
    );
    console.log("Successfully converted users.status to TEXT!");
  } catch (err) {
    console.error("Conversion error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

checkCast();

