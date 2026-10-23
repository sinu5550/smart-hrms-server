require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function runStatements() {
  const statements = [
    `ALTER TABLE hrms.attendances ADD COLUMN IF NOT EXISTS punch_in_latitude DOUBLE PRECISION`,
    `ALTER TABLE hrms.attendances ADD COLUMN IF NOT EXISTS punch_in_longitude DOUBLE PRECISION`,
    `ALTER TABLE hrms.attendances ADD COLUMN IF NOT EXISTS punch_in_address TEXT`,
    `ALTER TABLE hrms.attendances ADD COLUMN IF NOT EXISTS punch_in_device_type VARCHAR(50) DEFAULT 'WEB_PORTAL'`,
    `ALTER TABLE hrms.attendances ADD COLUMN IF NOT EXISTS punch_in_selfie_url TEXT`,
    `ALTER TABLE hrms.attendances ADD COLUMN IF NOT EXISTS punch_out_latitude DOUBLE PRECISION`,
    `ALTER TABLE hrms.attendances ADD COLUMN IF NOT EXISTS punch_out_longitude DOUBLE PRECISION`,
    `ALTER TABLE hrms.attendances ADD COLUMN IF NOT EXISTS punch_out_address TEXT`,

    `ALTER TABLE hrms.organizations ADD COLUMN IF NOT EXISTS office_latitude DOUBLE PRECISION`,
    `ALTER TABLE hrms.organizations ADD COLUMN IF NOT EXISTS office_longitude DOUBLE PRECISION`,
    `ALTER TABLE hrms.organizations ADD COLUMN IF NOT EXISTS geofence_radius_meters INT DEFAULT 250`,
    `ALTER TABLE hrms.organizations ADD COLUMN IF NOT EXISTS enable_gps_attendance BOOLEAN DEFAULT true`,

    `CREATE TABLE IF NOT EXISTS hrms.biometric_devices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE,
        device_name VARCHAR(100) NOT NULL,
        device_serial_number VARCHAR(100) NOT NULL,
        device_model VARCHAR(100) DEFAULT 'ZKTeco / ADMS',
        ip_address VARCHAR(50),
        port INT DEFAULT 4370,
        location_name VARCHAR(100) DEFAULT 'Main Gate',
        status VARCHAR(20) DEFAULT 'ONLINE',
        last_heartbeat TIMESTAMPTZ,
        total_logs_synced INT DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uq_org_device_serial UNIQUE (organization_id, device_serial_number)
    )`,

    `CREATE TABLE IF NOT EXISTS hrms.biometric_raw_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE,
        device_id UUID REFERENCES hrms.biometric_devices(id) ON DELETE SET NULL,
        device_serial_number VARCHAR(100) NOT NULL,
        employee_id VARCHAR(50) NOT NULL,
        punch_time TIMESTAMPTZ NOT NULL,
        punch_type VARCHAR(20) DEFAULT 'CHECK_IN',
        verification_mode VARCHAR(20) DEFAULT 'FINGERPRINT',
        sync_status VARCHAR(20) DEFAULT 'PROCESSED',
        created_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE INDEX IF NOT EXISTS idx_raw_logs_org_emp ON hrms.biometric_raw_logs (organization_id, employee_id, punch_time)`,

    `CREATE TABLE IF NOT EXISTS hrms.outwork_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE,
        user_id UUID REFERENCES hrms.users(id) ON DELETE CASCADE,
        visit_date DATE NOT NULL,
        destination VARCHAR(255) NOT NULL,
        purpose TEXT NOT NULL,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        status VARCHAR(20) DEFAULT 'PENDING',
        approved_by UUID REFERENCES hrms.users(id) ON DELETE SET NULL,
        approval_notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS hrms.hr_loans (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE,
        user_id UUID REFERENCES hrms.users(id) ON DELETE CASCADE,
        loan_type VARCHAR(50) DEFAULT 'EMERGENCY',
        principal_amount NUMERIC(12,2) NOT NULL,
        tenure_months INT NOT NULL DEFAULT 12,
        monthly_installment NUMERIC(12,2) NOT NULL,
        total_repaid NUMERIC(12,2) DEFAULT 0,
        outstanding_balance NUMERIC(12,2) NOT NULL,
        reason TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'PENDING',
        approved_by UUID REFERENCES hrms.users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    )`
  ];

  try {
    for (const sql of statements) {
      await prisma.$executeRawUnsafe(sql);
    }
    console.log("All Phase 2 & 3 tables and columns created successfully!");
  } catch (err) {
    console.error("Statement execution error:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

runStatements();
