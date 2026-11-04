const { prisma } = require("./src/prisma");

async function setupCustomStatusTable() {
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS hrms.employment_status_configs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID NOT NULL,
        name VARCHAR(100) NOT NULL,
        code VARCHAR(100) NOT NULL,
        color VARCHAR(50) DEFAULT 'emerald',
        count_in_attendance BOOLEAN DEFAULT true,
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CONSTRAINT uq_org_status_code UNIQUE (organization_id, code)
      );
    `);
    console.log("Table hrms.employment_status_configs created or already exists!");

    // Seed default standard statuses for existing organizations if empty
    const orgs = await prisma.organization.findMany({ select: { id: true } });
    for (const org of orgs) {
      const existing = await prisma.$queryRawUnsafe(
        "SELECT id FROM hrms.employment_status_configs WHERE organization_id = $1::uuid",
        org.id
      );
      if (existing.length === 0) {
        const defaults = [
          { name: "ACTIVE", code: "ACTIVE", color: "emerald", count_in_attendance: true, is_default: true },
          { name: "ON PROBATION", code: "ON_PROBATION", color: "amber", count_in_attendance: true, is_default: false },
          { name: "RESIGNED", code: "RESIGNED", color: "slate", count_in_attendance: false, is_default: false },
          { name: "TERMINATED", code: "TERMINATED", color: "rose", count_in_attendance: false, is_default: false },
          { name: "SUSPENDED", code: "SUSPENDED", color: "orange", count_in_attendance: false, is_default: false },
        ];
        for (const def of defaults) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO hrms.employment_status_configs (organization_id, name, code, color, count_in_attendance, is_default)
             VALUES ($1::uuid, $2, $3, $4, $5, $6)
             ON CONFLICT (organization_id, code) DO NOTHING`,
            org.id, def.name, def.code, def.color, def.count_in_attendance, def.is_default
          );
        }
        console.log(`Seeded default statuses for org: ${org.id}`);
      }
    }
  } catch (err) {
    console.error("Error setting up employment status table:", err);
  } finally {
    await prisma.$disconnect();
  }
}

setupCustomStatusTable();

