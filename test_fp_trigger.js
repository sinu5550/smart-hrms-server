const http = require('http');

async function test(xmlPayload, urlPath = '/ISAPI/AccessControl/CaptureFingerPrint') {
  return new Promise((resolve) => {
    const queryPath = `/isapi?method=POST&path=${encodeURIComponent(urlPath)}`;
    const req = http.request({
      hostname: '2.24.171.175',
      port: 7661,
      path: queryPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        'Content-Length': Buffer.byteLength(xmlPayload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', (err) => resolve({ error: err.message }));
    req.write(xmlPayload);
    req.end();
  });
}

(async () => {
  // Let's test with employeeNo included in CaptureFingerPrint XML
  const xml1 = `<?xml version="1.0" encoding="UTF-8"?>
<CaptureFingerPrint version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
    <CaptureFingerPrintCond>
        <fingerNo>1</fingerNo>
        <employeeNo>EKH260022</employeeNo>
    </CaptureFingerPrintCond>
</CaptureFingerPrint>`;

  const xml2 = `<?xml version="1.0" encoding="UTF-8"?>
<CaptureFingerPrint version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
    <fingerNo>1</fingerNo>
    <employeeNo>EKH260022</employeeNo>
</CaptureFingerPrint>`;

  const xml3 = `<?xml version="1.0" encoding="UTF-8"?>
<CaptureFingerPrint version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
    <fingerPrintNo>1</fingerPrintNo>
    <employeeNo>EKH260022</employeeNo>
</CaptureFingerPrint>`;

  console.log("xml1 (with employeeNo in cond):", (await test(xml1)).data);
  console.log("xml2 (with employeeNo outer):", (await test(xml2)).data);
  console.log("xml3 (fingerPrintNo + employeeNo):", (await test(xml3)).data);
})();
