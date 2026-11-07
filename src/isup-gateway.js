/**
 * Hikvision ISUP 5.0 / E-Home Gateway TCP Server
 * -----------------------------------------------
 * Runs on Port 7660.
 * Listens for inbound TCP connection registrations & attendance events
 * pushed directly from Hikvision MinMoe Biometric Terminals over WAN/Internet.
 */

const net = require("net");

function setupIsupServer(prisma, isupPort = 7660) {
  const server = net.createServer((socket) => {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[ISUP Gateway] Inbound connection from ${remote}`);

    let buffer = Buffer.alloc(0);

    socket.on("data", async (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        const text = buffer.toString("utf8");

        console.log(`[ISUP Gateway RAW PACKET ${chunk.length} bytes]:`, text.substring(0, 300));
        console.log(`[ISUP Gateway HEX]:`, chunk.subarray(0, 32).toString("hex"));

        // Hikvision Binary ISUP EHome Registration Handling
        // Binary ISUP starts with 4-byte header or magic bytes followed by device ID and command
        // Response format: 4-byte header, cmd 0x0001 (registration reply), status 0x00 (success), session key/challenge
        
        let ackBuffer = null;

        // Check if binary packet (starts with 0x10 0x52 'ER' registration request)
        if (chunk.length >= 4 && chunk[0] === 0x10 && chunk[1] === 0x52) {
          console.log(`[ISUP Gateway] Exact ISUP 0x1052 Register Handshake matched!`);
          
          // Reply with matching 0x10 0x52 reply frame for GS6443083
          const devIdBuf = Buffer.from("GS6443083", "utf8");
          const replyHeader = Buffer.from([
            0x10, 0x52, // Protocol Signature (ER)
            0x02, 0x01, // Register Response Code
            0x00, 0x00, // Status: SUCCESS (0)
            0x00, devIdBuf.length
          ]);
          const replyPacket = Buffer.concat([replyHeader, devIdBuf]);

          socket.write(replyPacket);
          console.log(`[ISUP Gateway] Sent registration approval ACK to device.`);
          buffer = Buffer.alloc(0);
          return;
        }

        // Always immediately acknowledge any connection packet to satisfy ISUP handshake
        if (text.includes("Register") || text.includes("<devId>") || text.includes("deviceNo") || text.includes("ISUP") || chunk.length > 0) {
          console.log(`[ISUP Gateway] Received registration packet from ${remote}`);

          // Extract device ID / Serial if present
          const devMatch = text.match(/<devId>([^<]+)<\/devId>/i) ||
                           text.match(/<deviceNo>([^<]+)<\/deviceNo>/i) ||
                           text.match(/"deviceNo"\s*:\s*"([^"]+)"/i) ||
                           text.match(/DS-[A-Z0-9]+/i);
          const detectedSerial = devMatch ? devMatch[1] || devMatch[0] : null;

          if (detectedSerial) {
            console.log(`[ISUP Gateway] Recognized Device Serial: ${detectedSerial}`);
            // Update device in DB as ONLINE and record heartbeat
            try {
              await prisma.biometricDevice.updateMany({
                where: {
                  deviceSerialNumber: { contains: detectedSerial.replace(/[^A-Za-z0-9]/g, "") }
                },
                data: {
                  status: "ONLINE",
                  lastHeartbeat: new Date(),
                  ipAddress: socket.remoteAddress?.replace(/^.*:/, "")
                }
              });
            } catch (dbErr) {
              console.warn("[ISUP Gateway DB Notice]", dbErr.message);
            }
          }

          // Return Standard ISUP 5.0 Registration Acknowledgment / Success
          // ISUP expects a standard XML response with StatusCode 200 / StatusString OK
          const ackXml = `<?xml version="1.0" encoding="UTF-8"?>
<ResponseStatus version="2.0" xmlns="http://www.hikvision.com/networks/schemas/ISUP">
<requestURL>/ISUP/Register</requestURL>
<statusCode>200</statusCode>
<statusString>OK</statusString>
</ResponseStatus>`;

          // Also handle HTTP-style responses if device connects via HTTP/ISUP
          if (text.startsWith("POST ") || text.startsWith("GET ")) {
            const httpAck = `HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: ${Buffer.byteLength(ackXml)}\r\nConnection: keep-alive\r\n\r\n${ackXml}`;
            socket.write(httpAck);
          } else {
            // Binary / raw XML frame
            socket.write(ackXml);
          }
          buffer = Buffer.alloc(0);
        }

        // Case 2: Heartbeat Keep-Alive
        else if (text.includes("KeepAlive") || text.includes("heartbeat")) {
          const keepAliveAck = `<?xml version="1.0" encoding="UTF-8"?>
<ResponseStatus version="2.0" xmlns="http://www.hikvision.com/networks/schemas/ISUP">
<requestURL>/ISUP/KeepAlive</requestURL>
<statusCode>200</statusCode>
<statusString>OK</statusString>
</ResponseStatus>`;
          if (text.startsWith("POST ")) {
            socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(keepAliveAck)}\r\n\r\n${keepAliveAck}`);
          } else {
            socket.write(keepAliveAck);
          }
          buffer = Buffer.alloc(0);
        }

        // Case 3: Attendance Event / Verification Push
        else if (text.includes("AcsEvent") || text.includes("AccessControllerEvent") || text.includes("major")) {
          console.log(`[ISUP Gateway] Received Attendance Event payload!`);
          
          // Match employee number
          const empMatch = text.match(/<employeeNoString>([^<]+)<\/employeeNoString>/i) ||
                           text.match(/"employeeNoString"\s*:\s*"([^"]+)"/i) ||
                           text.match(/<cardNo>([^<]+)<\/cardNo>/i);
          const rawEmp = empMatch ? empMatch[1].trim() : null;

          if (rawEmp) {
            console.log(`[ISUP Gateway] Punch received for Employee: ${rawEmp}`);
            // Find employee & organization
            const users = await prisma.user.findMany({
              select: { id: true, employeeId: true, organizationId: true, fullName: true }
            });
            const clean = rawEmp.trim();
            const cleanNoZeros = clean.replace(/^0+/, "");
            const userRec = users.find((u) => {
              if (u.employeeId === clean) return true;
              if (u.employeeId && u.employeeId.replace(/-/g, "") === clean) return true;
              const m = u.employeeId?.match(/\d+$/);
              if (m && (m[0] === clean || m[0].replace(/^0+/, "") === cleanNoZeros)) return true;
              return false;
            });

            if (userRec) {
              const punchDate = new Date();
              const dayUtcMidnight = new Date(Date.UTC(punchDate.getUTCFullYear(), punchDate.getUTCMonth(), punchDate.getUTCDate()));

              // Save to BiometricRawLog
              await prisma.biometricRawLog.create({
                data: {
                  organizationId: userRec.organizationId,
                  employeeId: userRec.employeeId,
                  punchTime: punchDate,
                  punchType: "CHECK_IN",
                  verificationMode: text.includes("face") ? "FACE_SCAN" : "FINGERPRINT",
                  syncStatus: "PROCESSED",
                }
              });

              // Check existing attendance
              const existingAtt = await prisma.attendance.findUnique({
                where: {
                  userId_date: {
                    userId: userRec.id,
                    date: dayUtcMidnight,
                  }
                }
              });

              if (!existingAtt) {
                await prisma.attendance.create({
                  data: {
                    organizationId: userRec.organizationId,
                    userId: userRec.id,
                    date: dayUtcMidnight,
                    checkInTime: punchDate,
                    currentState: "CHECKED_IN",
                    status: "PRESENT",
                    punchInDeviceType: "BIOMETRIC_TERMINAL",
                    punchInAddress: "Hikvision ISUP Gateway",
                  }
                });
                console.log(`[ISUP Gateway] Checked In ${userRec.fullName}`);
              } else if (existingAtt.checkInTime && punchDate.getTime() > existingAtt.checkInTime.getTime() + 60000) {
                const elapsedMinutes = Math.max(0, Math.round((punchDate.getTime() - existingAtt.checkInTime.getTime()) / (1000 * 60)));
                await prisma.attendance.update({
                  where: { id: existingAtt.id },
                  data: {
                    checkOutTime: punchDate,
                    currentState: "CHECKED_OUT",
                    totalWorkMinutes: elapsedMinutes,
                    punchOutAddress: "Hikvision ISUP Gateway",
                  }
                });
                console.log(`[ISUP Gateway] Checked Out ${userRec.fullName}`);
              }
            }
          }

          // Acknowledge Event
          const eventAck = `<?xml version="1.0" encoding="UTF-8"?>
<ResponseStatus version="2.0" xmlns="http://www.hikvision.com/networks/schemas/ISUP">
<requestURL>/ISUP/Event</requestURL>
<statusCode>200</statusCode>
<statusString>OK</statusString>
</ResponseStatus>`;
          socket.write(text.startsWith("POST ") ? `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(eventAck)}\r\n\r\n${eventAck}` : eventAck);
          buffer = Buffer.alloc(0);
        }
      } catch (err) {
        console.error("[ISUP Gateway Error]", err.message);
      }
    });

    socket.on("error", (err) => {
      // Quietly handle client resets
      if (err.code !== "ECONNRESET") {
        console.warn("[ISUP Socket Notice]", err.message);
      }
    });

    socket.on("close", () => {
      // connection closed
    });
  });

  server.on("error", (err) => {
    console.warn(`[ISUP Gateway Server Notice] Failed on port ${isupPort}:`, err.message);
  });

  server.listen(isupPort, "0.0.0.0", () => {
    console.log(`🚀 [Hikvision ISUP 5.0 Gateway] Live & Listening on TCP port ${isupPort} (Build v1.0.2 Ready)`);
  });

  return server;
}

module.exports = { setupIsupServer };

