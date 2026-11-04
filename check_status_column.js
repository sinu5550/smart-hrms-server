const { prisma } = require("./src/prisma");

async function checkStatusColumn() {
  try {
    const raw = await prisma.$queryRawUnsafe(
      "SELECT column_name, data_type, udt_name FROM information_schema.columns WHERE table_schema = 'hrms' AND table_name = 'users' AND column_name = 'status'"
    );
    console.log("Column Info:", raw);

    const enumValues = await prisma.$queryRawUnsafe(
      "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid WHERE t.typname = 'EmploymentStatus'"
    );
    console.log("Enum Values:", enumValues);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

checkStatusColumn();

