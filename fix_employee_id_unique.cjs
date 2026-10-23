require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function run() {
  try {
    console.log("Dropping global UNIQUE constraint on employee_id...");
    await prisma.$executeRawUnsafe(`ALTER TABLE hrms.users DROP CONSTRAINT IF EXISTS users_employee_id_key;`);
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS hrms.users_employee_id_key;`);

    console.log("Creating compound UNIQUE index on (organization_id, employee_id)...");
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_organization_employee_id_key 
      ON hrms.users (organization_id, employee_id);
    `);
    console.log("Done! employee_id is now unique per organization, not globally!");
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
