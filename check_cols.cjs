require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function checkOrgColumns() {
  try {
    const cols = await prisma.$queryRawUnsafe(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_schema = 'hrms' AND table_name = 'organizations';
    `);
    console.log("ORGANIZATIONS_COLUMNS:", JSON.stringify(cols, null, 2));

    const userCols = await prisma.$queryRawUnsafe(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_schema = 'hrms' AND table_name = 'users';
    `);
    console.log("USERS_COLUMNS:", JSON.stringify(userCols.filter(c => c.column_name === 'phone'), null, 2));
  } catch (err) {
    console.error("ERROR:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkOrgColumns();
