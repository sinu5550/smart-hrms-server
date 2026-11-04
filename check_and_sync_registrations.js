const { prisma } = require("./src/prisma");

async function checkSync() {
  try {
    const regs = await prisma.employeeRegistration.findMany({});
    console.log("Total Registrations in DB:", regs.length);
    for (const r of regs) {
      console.log("REG:", r.fullName, "| email:", r.email, "| DOB:", r.dateOfBirth, "| Gender:", r.gender, "| NID:", r.nidOrPassport);
      const u = await prisma.user.findFirst({ where: { email: r.email } });
      if (u) {
        console.log(" -> MATCHED USER:", u.fullName, "| DOB:", u.dateOfBirth, "| Gender:", u.gender, "| NID:", u.nidOrPassport);
        // If the user had missing fields from earlier enlistment without DOB/Gender/NID, auto-sync now!
        const updates = {};
        if (!u.dateOfBirth && r.dateOfBirth) updates.dateOfBirth = r.dateOfBirth;
        if (!u.gender && r.gender) updates.gender = r.gender;
        if (!u.nidOrPassport && r.nidOrPassport) updates.nidOrPassport = r.nidOrPassport;
        if (!u.presentAddress && r.presentAddress) updates.presentAddress = r.presentAddress;
        if (!u.permanentAddress && r.permanentAddress) updates.permanentAddress = r.permanentAddress;
        if (!u.emergencyContactName && r.emergencyContactName) updates.emergencyContactName = r.emergencyContactName;
        if (!u.emergencyContactPhone && r.emergencyContactPhone) updates.emergencyContactPhone = r.emergencyContactPhone;
        if (!u.emergencyContactRelation && r.emergencyContactRelation) updates.emergencyContactRelation = r.emergencyContactRelation;

        if (Object.keys(updates).length > 0) {
          await prisma.user.update({
            where: { id: u.id },
            data: updates,
          });
          console.log(" -> AUTO-SYNCED MISSING FIELDS TO USER:", Object.keys(updates));
        }
      }
    }
  } catch (err) {
    console.error("Error in checkSync:", err);
  } finally {
    await prisma.$disconnect();
  }
}

checkSync();

