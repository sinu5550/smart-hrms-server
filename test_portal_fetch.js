const https = require('https');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function buildDigestHeader(method, uri, username, password, authHeader, nc = '00000001', cnonce = 'abc123xyz') {
  const parseParam = (key) => {
    const match = authHeader.match(new RegExp(key + '="?([^",]+)"?'));
    return match ? match[1] : '';
  };
  const realm = parseParam('realm');
  const nonce = parseParam('nonce');
  const qop = parseParam('qop');
  const ha1 = crypto.createHash('md5').update(username + ':' + realm + ':' + password).digest('hex');
  const ha2 = crypto.createHash('md5').update(method + ':' + uri).digest('hex');
  let response;
  if (qop) {
    response = crypto.createHash('md5').update(ha1 + ':' + nonce + ':' + nc + ':' + cnonce + ':' + qop + ':' + ha2).digest('hex');
    return 'Digest username="' + username + '", realm="' + realm + '", nonce="' + nonce + '", uri="' + uri + '", qop=' + qop + ', nc=' + nc + ', cnonce="' + cnonce + '", response="' + response + '"';
  }
  response = crypto.createHash('md5').update(ha1 + ':' + nonce + ':' + ha2).digest('hex');
  return 'Digest username="' + username + '", realm="' + realm + '", nonce="' + nonce + '", uri="' + uri + '", response="' + response + '"';
}

async function test() {
  const host = '192.168.68.69';
  const path = '/ISAPI/AccessControl/UserInfo/Search?format=json';
  const body = JSON.stringify({ UserInfoSearchCond: { searchID: '1', searchResultPosition: 0, maxResults: 100 } });

  const t0 = Date.now();
  console.log("Starting probe...");
  const data = await new Promise((resolve, reject) => {
    const req1 = https.request({
      hostname: host, port: 443, path, method: 'POST', rejectUnauthorized: false, timeout: 8000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': 0 }
    }, (res1) => {
      console.log('res1 status:', res1.statusCode, 'took:', Date.now() - t0, 'ms');
      if (res1.statusCode === 401) {
        const digest = buildDigestHeader('POST', path, 'admin', 'ekhone121', res1.headers['www-authenticate']);
        const req2 = https.request({
          hostname: host, port: 443, path, method: 'POST', rejectUnauthorized: false, timeout: 8000,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: digest }
        }, (res2) => {
          let b = '';
          res2.on('data', c => b += c);
          res2.on('end', () => {
            console.log('res2 status:', res2.statusCode, 'took:', Date.now() - t0, 'ms');
            try {
              const parsed = JSON.parse(b);
              resolve(parsed);
            } catch(e) {
              reject(e);
            }
          });
        });
        req2.on('error', reject);
        req2.write(body);
        req2.end();
      } else {
        reject(new Error("res1 status not 401: " + res1.statusCode));
      }
    });
    req1.on('error', reject);
    req1.end();
  });

  const users = data?.UserInfoSearch?.UserInfo || [];
  console.log("Total users found on terminal:", users.length);
  users.forEach(u => console.log(`empNo: "${u.employeeNo}" | name: "${u.name}"`));
  process.exit(0);
}

test().catch(err => {
  console.error("Test failed:", err.message);
  process.exit(1);
});
