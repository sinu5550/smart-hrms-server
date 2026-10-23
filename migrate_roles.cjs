require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function createRolesTable() {
  try {
    console.log("Creating hrms.roles table and linking to users...");
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS hrms.roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        permissions JSONB DEFAULT '[]'::jsonb,
        is_system BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_org_role_name UNIQUE (organization_id, name)
      );
    `);

    await prisma.$executeRawUnsafe(`
      ALTER TABLE hrms.users 
      ADD COLUMN IF NOT EXISTS custom_role_id UUID REFERENCES hrms.roles(id) ON DELETE SET NULL;
    `);

    console.log("Successfully created hrms.roles and updated hrms.users!");
  } catch (err) {
    console.error("Migration error:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

createRolesTable();
