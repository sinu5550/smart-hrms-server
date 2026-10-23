require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function runPhase4Migration() {
  const statements = [
    // 1. Branches Table
    `CREATE TABLE IF NOT EXISTS hrms.branches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE,
        name VARCHAR(150) NOT NULL,
        code VARCHAR(50) NOT NULL,
        address TEXT,
        city VARCHAR(100),
        phone VARCHAR(50),
        email VARCHAR(150),
        is_head_office BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_branch_org_code UNIQUE (organization_id, code)
    )`,

    // 2. Add branch_id to users
    `ALTER TABLE hrms.users ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES hrms.branches(id) ON DELETE SET NULL`,

    // 3. Holidays Table
    `CREATE TABLE IF NOT EXISTS hrms.holidays (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE,
        title VARCHAR(150) NOT NULL,
        from_date DATE NOT NULL,
        to_date DATE NOT NULL,
        total_days INT DEFAULT 1,
        holiday_type VARCHAR(50) DEFAULT 'PUBLIC',
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // 4. Job Grades Table (Organogram & Pay scale ranking)
    `CREATE TABLE IF NOT EXISTS hrms.job_grades (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE,
        grade_name VARCHAR(100) NOT NULL,
        grade_level INT NOT NULL,
        min_basic NUMERIC(12,2) DEFAULT 0,
        max_basic NUMERIC(12,2) DEFAULT 0,
        description TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_grade_org_name UNIQUE (organization_id, grade_name)
    )`,

    // 5. Add grade_id to users
    `ALTER TABLE hrms.users ADD COLUMN IF NOT EXISTS grade_id UUID REFERENCES hrms.job_grades(id) ON DELETE SET NULL`,

    // 6. Gazette Wage Rules Table
    `CREATE TABLE IF NOT EXISTS hrms.gazette_rules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE,
        gazette_name VARCHAR(150) NOT NULL,
        basic_percentage NUMERIC(5,2) DEFAULT 50.00,
        house_rent_percentage NUMERIC(5,2) DEFAULT 25.00,
        medical_allowance_fixed NUMERIC(10,2) DEFAULT 4500.00,
        conveyance_allowance_fixed NUMERIC(10,2) DEFAULT 3500.00,
        food_allowance_fixed NUMERIC(10,2) DEFAULT 2500.00,
        overtime_multiplier NUMERIC(4,2) DEFAULT 2.00,
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // 7. ID Card Templates Studio Table
    `CREATE TABLE IF NOT EXISTS hrms.id_card_templates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE,
        template_name VARCHAR(150) NOT NULL,
        primary_color VARCHAR(20) DEFAULT '#047857',
        accent_color VARCHAR(20) DEFAULT '#0f172a',
        show_blood_group BOOLEAN DEFAULT true,
        show_emergency_contact BOOLEAN DEFAULT true,
        show_qr_code BOOLEAN DEFAULT true,
        show_barcode BOOLEAN DEFAULT false,
        custom_footer_text TEXT DEFAULT 'If found, please return to office administration.',
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`
  ];

  try {
    for (const sql of statements) {
      await prisma.$executeRawUnsafe(sql);
    }
    console.log("Phase 4 schema migration completed successfully!");
  } catch (err) {
    console.error("Migration error:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

runPhase4Migration();
