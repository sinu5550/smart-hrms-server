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

const host = "192.168.68.69";
const path = "/ISAPI/AccessControl/AcsEvent?format=json";
const user = "admin";
const pass = "ekhone121";

// Search today's authentication events (major 5 = access control)
const body = JSON.stringify({
  AcsEventCond: {
    searchID: "1",
    searchResultPosition: 0,
    maxResults: 30,
    major: 5,
    startTime: "2026-10-27T00:00:00+06:00",
    endTime: "2026-10-27T23:59:59+06:00",
  }
});

const req1 = https.request({
  hostname: host,
  port: 443,
  path,
  method: "POST",
  rejectUnauthorized: false,
  headers: { "Content-Type": "application/json", "Content-Length": 0 }
}, (res1) => {
  if (res1.statusCode === 401 && res1.headers["www-authenticate"]) {
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
        "Content-Length": Buffer.byteLength(body),
        Authorization: digest
      }
    }, (res2) => {
      let b = "";
      res2.on("data", c => b += c);
      res2.on("end", () => {
        try {
          const parsed = JSON.parse(b);
          console.log("TODAY EVENTS TOTAL:", parsed.AcsEvent?.totalMatches);
          const list = parsed.AcsEvent?.InfoList || [];
          console.log("TODAY EVENTS:", JSON.stringify(list.map(e => ({
            time: e.time,
            employeeNo: e.employeeNoString,
            name: e.name,
            major: e.major,
            minor: e.minor,
            currentVerifyMode: e.currentVerifyMode,
            cardReaderNo: e.cardReaderNo,
          })), null, 2));
        } catch (e) {
          console.log("ERR:", e.message, b);
        }
      });
    });
    req2.write(body);
    req2.end();
  }
});
req1.end();
