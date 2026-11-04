const { prisma } = require("./src/prisma");

async function main() {
  const newRelease = await prisma.systemUpdateRelease.create({
    data: {
      versionCode: 3,
      versionName: "v2.2.0-Patch",
      patchZipUrl: "https://app.creativeboxbd.com/downloads/SmartHRM-Desktop-Patch.zip",
      fileSizeMb: 34.6,
      releaseNotes: "Permanent status naming, dynamic attendance counts, employee birthdays modal, 5 KPI cards restoration, department-wise attendance breakdown, and paid break overtime policy.",
      isMandatory: false,
    },
  });
  console.log("Created new update release in DB:", newRelease);
  await prisma.$disconnect();
}

main();
