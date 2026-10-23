require("dotenv/config");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function run() {
  try {
    const user = await prisma.user.findFirst({
      where: { email: "ahmedsiyan33@gmail.com" },
      include: { organization: true }
    });
    console.log("Current User:", user);

    if (user) {
      // Re-activate owner
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { status: "ACTIVE" }
      });
      console.log("User updated to ACTIVE:", updated.email, updated.status);
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await prisma.$disconnect();
  }
}

run();
