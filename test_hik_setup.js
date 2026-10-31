const https = require("https");
const crypto = require("crypto");

function buildDigestHeader(method, uri, user, pass, authHeader) {
  const nonceMatch = authHeader.match(/nonce="([^"]+)"/);
  const realmMatch = authHeader.match(/realm="([^"]+)"/);
  const qopMatch = authHeader.match(/qop="([^"]+)"/);
  if (!nonceMatch || !realmMatch) return null;
  const nonce = nonceMatch[1];
  const realm = realmMatch[1];
  const qop = qopMatch ? qopMatch[1] : null;
  const cnonce = crypto.randomBytes(8).toString("hex");
  const nc = "00000001";
  const ha1 = crypto.createHash("md5").update(user + ":" + realm + ":" + pass).digest("hex");
  const ha2 = crypto.createHash("md5").update(method + ":" + uri).digest("hex");
  let response;
  if (qop) {
    response = crypto.createHash("md5").update(ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + ha2).digest("hex");
    return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  } else {
    response = crypto.createHash("md5").update(ha1 + ":" + nonce + ":" + ha2).digest("hex");
    return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  }
}

async function testSetUp(employeeNo, name) {
  const host = "192.168.68.69";
  const user = "admin";
  const pass = "ekhone121";
  const path = "/ISAPI/AccessControl/UserInfo/SetUp?format=json";

  const payload = JSON.stringify({
    UserInfo: {
      employeeNo: String(employeeNo),
      name: String(name),
      userType: "normal",
      Valid: {
        enable: true,
        beginTime: "2026-01-01T00:00:00",
        endTime: "2036-12-31T23:59:59",
        timeType: "local",
      },
      doorRight: "1",
      RightPlan: [{ doorNo: 1, planTemplateNo: "1" }],
    },
  });

  return new Promise((resolve, reject) => {
    const req1 = https.request({
      hostname: host,
      port: 443,
      path,
      method: "PUT",
      rejectUnauthorized: false,
      headers: { "Content-Type": "application/json", "Content-Length": 0 },
    }, (res1) => {
      const auth = res1.headers["www-authenticate"];
      const digest = buildDigestHeader("PUT", path, user, pass, auth);
      const req2 = https.request({
        hostname: host,
        port: 443,
        path,
        method: "PUT",
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: digest,
        },
      }, (res2) => {
        let d = "";
        res2.on("data", c => d += c);
        res2.on("end", () => {
          resolve({ status: res2.statusCode, body: d });
        });
      });
      req2.on("error", reject);
      req2.write(payload);
      req2.end();
    });
    req1.on("error", reject);
    req1.end();
  });
}

testSetUp("3", "KAMRUL").then(console.log).catch(console.error);
