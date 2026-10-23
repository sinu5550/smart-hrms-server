require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function runMigration() {
  console.log("Starting database schema migration for HRMS multi-tenant support...");

  const queries = [
    // 1. Create Enums if they do not exist
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'Role' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'hrms')) THEN
         CREATE TYPE hrms."Role" AS ENUM ('PLATFORM_ADMIN', 'ADMIN', 'HR', 'EMPLOYEE');
       END IF;
     END $$;`,

    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OrganizationStatus' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'hrms')) THEN
         CREATE TYPE hrms."OrganizationStatus" AS ENUM ('PENDING_VERIFICATION', 'TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED');
       END IF;
     END $$;`,

    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubscriptionPlan' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'hrms')) THEN
         CREATE TYPE hrms."SubscriptionPlan" AS ENUM ('STARTER', 'GROWTH', 'ENTERPRISE');
       END IF;
     END $$;`,

    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubscriptionStatus' AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'hrms')) THEN
         CREATE TYPE hrms."SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');
       END IF;
     END $$;`,

    // 2. Create organizations table if not exists
    `CREATE TABLE IF NOT EXISTS hrms.organizations (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       name TEXT NOT NULL,
       slug TEXT UNIQUE DEFAULT gen_random_uuid()::text,
       email_domain TEXT NOT NULL,
       employee_prefix TEXT UNIQUE DEFAULT 'ORG',
       owner_email TEXT UNIQUE NOT NULL,
       logo_url TEXT,
       status hrms."OrganizationStatus" DEFAULT 'PENDING_VERIFICATION',
       domain_verified_at TIMESTAMP,
       verification_token_hash TEXT,
       verification_expires_at TIMESTAMP,
       created_at TIMESTAMP NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMP NOT NULL DEFAULT NOW()
     );`,

    // 3. Create organization_subscriptions table if not exists
    `CREATE TABLE IF NOT EXISTS hrms.organization_subscriptions (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       organization_id UUID NOT NULL REFERENCES hrms.organizations(id) ON DELETE CASCADE,
       plan hrms."SubscriptionPlan" DEFAULT 'STARTER',
       status hrms."SubscriptionStatus" DEFAULT 'TRIALING',
       trial_ends_at TIMESTAMP,
       current_period_end TIMESTAMP,
       created_at TIMESTAMP NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMP NOT NULL DEFAULT NOW()
     );`,

    // 4. Add organization_id to users if not exists
    `ALTER TABLE hrms.users ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE;`,
    `ALTER TABLE hrms.users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT false;`,

    // 5. Add organization_id to other tenant-scoped tables
    `ALTER TABLE hrms.departments ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES hrms.organizations(id);`,
    `ALTER TABLE hrms.designations ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES hrms.organizations(id);`,
    `ALTER TABLE hrms.office_settings ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES hrms.organizations(id);`,
    `ALTER TABLE hrms.office_networks ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES hrms.organizations(id);`,
    `ALTER TABLE hrms.attendances ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES hrms.organizations(id);`,
    `ALTER TABLE hrms.leave_types ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE;`,
    `ALTER TABLE hrms.leave_balances ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE;`,
    `ALTER TABLE hrms.leave_requests ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE;`,
    `ALTER TABLE hrms.salary_structures ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE;`,
    `ALTER TABLE hrms.payroll_slips ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES hrms.organizations(id) ON DELETE CASCADE;`,
  ];

  for (let i = 0; i < queries.length; i++) {
    console.log(`Executing step ${i + 1}/${queries.length}...`);
    await prisma.$executeRawUnsafe(queries[i]);
  }

  console.log("Migration executed successfully!");
}

runMigration()
  .catch((e) => {
    console.error("Migration error:", e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
