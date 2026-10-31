const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const https = require("https");
const crypto = require("crypto");

function buildDigestHeader(method, uri, user, pass, authHeader) {
  const parts = {};
  authHeader.replace(/^Digest\s+/, "").split(/,\s*/).forEach(p => {
    const idx = p.indexOf("=");
    if (idx !== -1) parts[p.slice(0, idx).trim()] = p.slice(idx + 1).replace(/"/g, "").trim();
  });
  const realm = parts.realm || "";
  const nonce = parts.nonce || "";
  const qop = parts.qop || "";
  const cnonce = crypto.randomBytes(8).toString("hex");
  const nc = "00000001";
  const ha1 = crypto.createHash("md5").update(`${user}:${realm}:${pass}`).digest("hex");
  const ha2 = crypto.createHash("md5").update(`${method}:${uri}`).digest("hex");
  if (qop.includes("auth")) {
    const response = crypto.createHash("md5").update(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`).digest("hex");
    return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  } else {
    const response = crypto.createHash("md5").update(`${ha1}:${nonce}:${ha2}`).digest("hex");
    return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  }
}

async function run() {
  const device = await prisma.biometricDevice.findFirst({
    where: { ipAddress: "192.168.68.69" },
  });
  if (!device) return console.log("Device not found");
  console.log("Found device:", device.deviceName, device.organizationId);

  const user = device.username || "admin";
  const pass = device.password || "";
  const host = device.ipAddress;
  const path = "/ISAPI/AccessControl/AcsEvent?format=json";

  const fetchBody = JSON.stringify({
    AcsEventCond: {
      searchID: "1",
      searchResultPosition: Math.max(0, 6018 - 50),
      maxResults: 60,
      major: 0,
      minor: 0,
    },
  });

  const eventsList = await new Promise((resolve, reject) => {
    const req1 = https.request({
      hostname: host,
      port: 443,
      path,
      method: "POST",
      rejectUnauthorized: false,
      headers: { "Content-Type": "application/json", "Content-Length": 0 }
    }, (res1) => {
      const auth = res1.headers["www-authenticate"];
      const digest = buildDigestHeader("POST", path, user, pass, auth);
      const req2 = https.request({
        hostname: host,
        port: 443,
        path,
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(fetchBody),
          Authorization: digest,
        }
      }, (res2) => {
        let buf = "";
        res2.on("data", c => buf += c);
        res2.on("end", () => {
          try {
            resolve(JSON.parse(buf).AcsEvent?.InfoList || []);
          } catch(e) { resolve([]); }
        });
      });
      req2.write(fetchBody);
      req2.end();
    });
    req1.end();
  });

  console.log("Returned raw events:", eventsList.length);

  const personEvents = eventsList.filter(
    (e) => e.major === 5 && (e.minor === 75 || e.minor === 38 || e.minor === 104 || e.minor === 1) && e.employeeNoString
  );
  console.log("Filtered person events:", personEvents.length);

  for (const ev of personEvents) {
    const rawEmp = String(ev.employeeNoString).trim();
    const punchDate = new Date(ev.time);
    console.log("Processing event:", rawEmp, ev.name, ev.time, "minor:", ev.minor);

    const userRec = await prisma.user.findFirst({
      where: {
        organizationId: device.organizationId,
        OR: [
          { employeeId: rawEmp },
          { employeeId: { endsWith: rawEmp } },
          { employeeId: { endsWith: rawEmp.replace(/^0+/, "") } },
        ],
      },
    });

    if (!userRec) {
      console.log("  -> User not found for emp:", rawEmp);
      continue;
    }
    console.log("  -> Matched user:", userRec.fullName, userRec.employeeId, userRec.id);

    // Save raw punch
    const existingLog = await prisma.biometricRawLog.findFirst({
      where: {
        organizationId: device.organizationId,
        employeeId: userRec.employeeId,
        punchTime: punchDate,
      },
    });

    if (!existingLog) {
      await prisma.biometricRawLog.create({
        data: {
          organizationId: device.organizationId,
          deviceId: device.id,
          deviceSerialNumber: device.deviceSerialNumber,
          employeeId: userRec.employeeId,
          punchTime: punchDate,
          punchType: "CHECK_IN",
          verificationMode: ev.minor === 75 ? "FACE_SCAN" : "FINGERPRINT",
          syncStatus: "PROCESSED",
        },
      });
      console.log("  -> Created BiometricRawLog for", userRec.fullName);
    }

    // Save attendance
    const utcMidnight = new Date(
      Date.UTC(punchDate.getUTCFullYear(), punchDate.getUTCMonth(), punchDate.getUTCDate())
    );

    const existingAtt = await prisma.attendance.findUnique({
      where: {
        userId_date: {
          userId: userRec.id,
          date: utcMidnight,
        },
      },
    });

    if (!existingAtt) {
      await prisma.attendance.create({
        data: {
          organizationId: device.organizationId,
          userId: userRec.id,
          date: utcMidnight,
          checkInTime: punchDate,
          currentState: "CHECKED_IN",
          status: "PRESENT",
          ipAddress: device.ipAddress,
          punchInDeviceType: "BIOMETRIC_TERMINAL",
          punchInAddress: device.locationName,
        },
      });
      console.log("  -> CREATED ATTENDANCE RECORD (CHECKED_IN) for", userRec.fullName, punchDate);
    } else {
      console.log("  -> Existing attendance already recorded for", userRec.fullName, existingAtt.checkInTime, existingAtt.currentState);
    }
  }
}

run().catch(console.error).finally(() => prisma.$disconnect());
