# Tenant ID and login migration

The Prisma schema uses UUID primary keys, globally unique user email addresses, unique organization owner emails, an automatically assigned employee prefix, and HR-assigned employee login keys such as `EKH-26-0001`. The employee table's `id` remains a UUID and is separate from this login key.

The existing database has not been migrated. Do not run `prisma db push` against a database with existing HRMS data. Before deployment:

1. Take a database backup and inspect the target database schema.
2. Normalize existing user and owner emails to lowercase. Find duplicate user emails (case-insensitive) and duplicate organization owner emails; resolve them before adding global unique indexes. Email login intentionally resolves to one account and therefore one tenant.
3. Backfill an employee prefix for every existing organization, ensuring each prefix is unique.
4. Backfill existing tenant-owned departments, designations, office settings/networks, attendance, leave, salary and payroll rows to the correct organization. Assign each existing employee a unique key in the `PREFIX-YY-NNNN` format while preserving their UUID `id` primary keys. Do not change foreign-key UUIDs.
5. Remove the old organization-scoped email unique index and any unique email-domain index, then add global uniqueness for `users.email` and `organizations.owner_email`.
6. Apply the reviewed migration to a backup/staging copy first, then regenerate Prisma Client and build the server.

The seed script is not a database migration. It requires platform-admin and HR credentials in the server's local environment, and has not been run.
