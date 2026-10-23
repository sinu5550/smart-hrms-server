require("dotenv/config");
const bcrypt = require("bcrypt");
const { PrismaClient, Role, OrganizationStatus, SubscriptionPlan, SubscriptionStatus } = require("@prisma/client");
const prisma = new PrismaClient();

function required(key) {
  const value = process.env[key];
  if (!value || !value.trim()) throw new Error(`Missing required seed environment variable: ${key}`);
  return value.trim();
}

async function upsertUser({ organizationId, email, employeeId, phone, fullName, role, password, mustChangePassword }) {
  const normalizedEmail = email.toLowerCase();
  const existing = await prisma.user.findFirst({ where: { organizationId, email: normalizedEmail } });
  const data = { organizationId, email: normalizedEmail, employeeId: existing?.employeeId || employeeId, phone, fullName, role, passwordHash: await bcrypt.hash(password, 12), mustChangePassword, isDeleted: false };
  return existing ? prisma.user.update({ where: { id: existing.id }, data }) : prisma.user.create({ data });
}

async function main() {
  const platformEmail = required("PLATFORM_ADMIN_EMAIL").toLowerCase();
  const platformPassword = required("PLATFORM_ADMIN_PASSWORD");
  if (platformPassword.length < 6) throw new Error("Platform-admin password must be at least 6 characters.");
  await upsertUser({ organizationId: null, email: platformEmail, employeeId: require("crypto").randomUUID(), phone: process.env.PLATFORM_ADMIN_PHONE || null, fullName: process.env.PLATFORM_ADMIN_NAME || "Platform Administrator", role: Role.PLATFORM_ADMIN, password: platformPassword, mustChangePassword: false });

  // Tenant HR seeding is optional. Supplying no SEED_HR_EMAIL provisions only the platform admin.
  if (!process.env.SEED_HR_EMAIL?.trim()) {
    console.log(`Seeded platform admin ${platformEmail}. Password was read from environment and is not printed.`);
    return;
  }
  const orgName = required("SEED_ORG_NAME");
  const hrEmail = required("SEED_HR_EMAIL").toLowerCase();
  const hrPassword = required("SEED_HR_PASSWORD");
  const hrName = required("SEED_HR_NAME");
  const hrPhone = required("SEED_HR_PHONE");
  if (hrPassword.length < 6) throw new Error("Tenant HR password must be at least 6 characters.");
  const organization = await prisma.organization.upsert({
    where: { ownerEmail: hrEmail },
    create: { name: orgName, slug: require("crypto").randomUUID(), emailDomain: hrEmail.split("@")[1], employeePrefix: (orgName.replace(/[^a-z0-9]/gi, "").slice(0, 4) || "ORG").toUpperCase(), ownerEmail: hrEmail, status: OrganizationStatus.TRIAL, domainVerifiedAt: new Date() },
    update: { name: orgName, status: OrganizationStatus.TRIAL, domainVerifiedAt: new Date() },
  });
  await upsertUser({ organizationId: organization.id, email: hrEmail, employeeId: process.env.SEED_HR_EMPLOYEE_ID || `${organization.employeePrefix}-26-0001`, phone: hrPhone, fullName: hrName, role: Role.HR, password: hrPassword, mustChangePassword: true });

  const current = await prisma.organizationSubscription.findFirst({ where: { organizationId: organization.id }, orderBy: { createdAt: "desc" } });
  const subscription = { plan: SubscriptionPlan.STARTER, status: SubscriptionStatus.TRIALING, trialEndsAt: new Date(Date.now() + 14 * 86400000) };
  if (current) await prisma.organizationSubscription.update({ where: { id: current.id }, data: subscription });
  else await prisma.organizationSubscription.create({ data: { organizationId: organization.id, ...subscription } });
  const shift = await prisma.officeSetting.findFirst({ where: { organizationId: organization.id, isDefault: true } });
  if (!shift) await prisma.officeSetting.create({ data: { organizationId: organization.id, shiftName: "Standard Day Shift", startTime: "09:00", endTime: "18:00", gracePeriodMinutes: 30, isDefault: true } });
  console.log(`Seeded platform admin ${platformEmail} and tenant HR ${hrEmail} for tenant ${organization.id}. Passwords were read from environment and are not printed.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
