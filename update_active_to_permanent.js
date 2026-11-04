const { prisma } = require("./src/prisma");

async function main() {
  try {
    const updateResult = await prisma.$executeRawUnsafe(
      "UPDATE hrms.employment_status_configs SET name = 'PERMANENT' WHERE code = 'ACTIVE' OR name = 'ACTIVE'"
    );
    console.log("Updated employment_status_configs rows:", updateResult);

    const statuses = await prisma.$queryRawUnsafe("SELECT * FROM hrms.employment_status_configs ORDER BY id ASC");
    console.log("Current statuses:", statuses);
  } catch (err) {
    console.error("Error updating:", err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
