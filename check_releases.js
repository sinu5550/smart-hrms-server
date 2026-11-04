const { prisma } = require("./src/prisma");

async function main() {
  const rels = await prisma.systemUpdateRelease.findMany({
    orderBy: { versionCode: "desc" },
  });
  console.log("Current systemUpdateRelease records:", rels);
  await prisma.$disconnect();
}

main();
