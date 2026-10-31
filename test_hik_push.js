const https = require('https');
const crypto = require('crypto');

function buildDigestHeader(method, uri, user, pass, authHeader) {
  const parts = {};
  authHeader.replace(/^Digest\s+/, '').split(/,\s*/).forEach(p => {
    const idx = p.indexOf('=');
    if (idx !== -1) parts[p.slice(0, idx).trim()] = p.slice(idx + 1).replace(/"/g, '').trim();
  });
  const realm = parts.realm || '';
  const nonce = parts.nonce || '';
  const qop = parts.qop || '';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = crypto.createHash('md5').update(user + ':' + realm + ':' + pass).digest('hex');
  const ha2 = crypto.createHash('md5').update(method + ':' + uri).digest('hex');
  if (qop.includes('auth')) {
    const response = crypto.createHash('md5').update(ha1 + ':' + nonce + ':' + nc + ':' + cnonce + ':auth:' + ha2).digest('hex');
    return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  } else {
    const response = crypto.createHash('md5').update(ha1 + ':' + nonce + ':' + ha2).digest('hex');
    return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  }
}

async function testPush() {
  const host = '192.168.68.69';
  const path = '/ISAPI/AccessControl/UserInfo/Detail/Delete?format=json';

  const body = JSON.stringify({
    UserInfoDetailDelCond: {
      EmployeeNoList: [{ employeeNo: '99' }]
    }
  });

  const res = await new Promise((resolve, reject) => {
    const req1 = https.request({
      hostname: host, port: 443, path, method: 'PUT', rejectUnauthorized: false, timeout: 6000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': 0 }
    }, (res1) => {
      console.log('Probe status:', res1.statusCode);
      if (res1.statusCode === 401 && res1.headers['www-authenticate']) {
        const digest = buildDigestHeader('PUT', path, 'admin', 'ekhone121', res1.headers['www-authenticate']);
        const req2 = https.request({
          hostname: host, port: 443, path, method: 'PUT', rejectUnauthorized: false, timeout: 6000,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            Authorization: digest
          }
        }, (res2) => {
          let b = '';
          res2.on('data', c => b += c);
          res2.on('end', () => resolve({ statusCode: res2.statusCode, body: b }));
        });
        req2.on('error', reject);
        req2.write(body);
        req2.end();
      } else {
        reject(new Error("Probe returned " + res1.statusCode));
      }
    });
    req1.on('error', reject);
    req1.end();
  });

  console.log("Hikvision SetUp Response:", res);
  process.exit(0);
}

testPush().catch(err => {
  console.error("Push failed:", err);
  process.exit(1);
});
