/**
 * SmartHRM Biometric Cloud Reverse-Tunnel & ISUP Relay Manager
 * ----------------------------------------------------
 * Maintains live WebSocket tunnels with on-premise local agents
 * AND bridges directly with the official native ISUP Gateway container on port 7661!
 */

const WebSocket = require("ws");
const http = require("http");

// Map of deviceSerialNumber -> WebSocket connection
const activeTunnels = new Map();
// Map of correlationId -> { resolve, reject, timer }
const pendingRequests = new Map();

// Dynamic working ISUP host resolution
let g_workingIsupHost = process.env.ISUP_GATEWAY_HOST || "2.24.171.175";
const ISUP_CANDIDATE_HOSTS = [
  process.env.ISUP_GATEWAY_HOST,
  "2.24.171.175",
  "127.0.0.1",
  "172.17.0.1",
  "hikvision-gateway-uoyomo",
  "hikvision-gateway",
  "host.docker.internal",
].filter(Boolean);

// Helper to send ISAPI via the native Linux ISUP Gateway service
function sendViaIsupGateway(method, path, body, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const isupHost = g_workingIsupHost;
    const isupPort = process.env.ISUP_GATEWAY_PORT || 7661;

    const queryParams = new URLSearchParams({
      method: method.toUpperCase(),
      path: path,
    }).toString();

    const postData = typeof body === "string" ? body : (body ? JSON.stringify(body) : "");

    const req = http.request(
      {
        host: isupHost,
        port: isupPort,
        path: `/isapi?${queryParams}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const rawBuf = Buffer.concat(chunks);
          let parsed = null;
          try {
            parsed = JSON.parse(rawBuf.toString());
          } catch {
            parsed = rawBuf.toString();
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: 200, data: parsed });
          } else {
            reject(new Error(`ISUP Gateway error (${res.statusCode}): ${JSON.stringify(parsed)}`));
          }
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("ISUP Gateway request timed out"));
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Check if ISUP Gateway is online and has active device
let g_isupGatewayOnline = false;
async function probeSingleHost(host, port) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host,
        port,
        path: "/status",
        timeout: 1500,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve({ ok: true, data });
          } catch (e) {
            resolve({ ok: false, err: "Invalid JSON" });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ ok: false, err: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, err: "Timeout" });
    });
  });
}

let g_lastProbeLog = 0;
async function checkIsupGatewayStatus() {
  const port = process.env.ISUP_GATEWAY_PORT || 7661;
  const now = Date.now();
  const shouldLog = (now - g_lastProbeLog) > 30000; // Log probe attempts every 30 seconds

  for (const host of ISUP_CANDIDATE_HOSTS) {
    const res = await probeSingleHost(host, port);
    if (res.ok && res.data) {
      if (!g_isupGatewayOnline || shouldLog) {
        console.log(`[ISUP Gateway Bridge] ✓ Connected to gateway at ${host}:${port}. Device online: ${res.data.online}`);
        g_lastProbeLog = now;
      }
      g_workingIsupHost = host;
      g_isupGatewayOnline = !!res.data.online;
      return g_isupGatewayOnline;
    } else if (shouldLog) {
      console.log(`[ISUP Gateway Probe] ${host}:${port} -> ${res.err || "failed"}`);
    }
  }

  if (shouldLog) g_lastProbeLog = now;
  g_isupGatewayOnline = false;
  return false;
}

// Periodically check ISUP gateway status
setInterval(checkIsupGatewayStatus, 10000);
setTimeout(checkIsupGatewayStatus, 1000);

function setupDeviceTunnelServer(httpServer) {
  const wss = new WebSocket.Server({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === "/api/devices/tunnel") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const serial = url.searchParams.get("serial") || "DEFAULT_TERMINAL";

    console.log(`[Tunnel Connected] Local agent for device serial "${serial}" established live bridge.`);
    activeTunnels.set(serial, ws);

    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "TUNNEL_RESPONSE" && msg.correlationId) {
          const pending = pendingRequests.get(msg.correlationId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingRequests.delete(msg.correlationId);
            pending.resolve(msg);
          }
        }
      } catch (e) {
        console.error("[Tunnel Message Parse Error]", e);
      }
    });

    ws.on("close", () => {
      console.log(`[Tunnel Disconnected] Local agent for "${serial}" disconnected.`);
      if (activeTunnels.get(serial) === ws) {
        activeTunnels.delete(serial);
      }
    });

    ws.on("error", (err) => {
      console.warn(`[Tunnel Error] Device "${serial}":`, err.message);
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on("close", () => {
    clearInterval(interval);
  });
}

/**
 * Send command to device:
 * 1. Priority 1: Direct native ISUP Gateway (cloud native, zero latency!)
 * 2. Priority 2: Fallback to WebSocket reverse-tunnel if agent is active
 */
async function sendDeviceCommandViaTunnel(serialNumber, { method, path, body, timeout = 10000 }) {
  // If ISUP gateway is reachable, use native ISUP 5.0 C++ PassThrough!
  try {
    const isupRes = await sendViaIsupGateway(method, path, body, timeout);
    return isupRes;
  } catch (isupErr) {
    console.warn(`[ISUP Gateway Send Error]:`, isupErr.message);
  }

  return new Promise((resolve, reject) => {
    let ws = activeTunnels.get(serialNumber);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      for (const [s, conn] of activeTunnels.entries()) {
        if (conn.readyState === WebSocket.OPEN) {
          ws = conn;
          break;
        }
      }
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error(`Both ISUP Gateway and Local Agent Bridge are offline for device "${serialNumber}".`));
    }

    const correlationId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const timer = setTimeout(() => {
      pendingRequests.delete(correlationId);
      reject(new Error(`Device request timed out after ${timeout / 1000}s via local tunnel.`));
    }, timeout);

    pendingRequests.set(correlationId, { resolve, reject, timer });

    ws.send(
      JSON.stringify({
        type: "TUNNEL_COMMAND",
        correlationId,
        method,
        path,
        body,
      })
    );
  });
}

function isDeviceTunnelOnline(serialNumber) {
  // Online if ISUP Gateway has active session OR WebSocket tunnel is open
  if (g_isupGatewayOnline) return true;

  const ws = activeTunnels.get(serialNumber);
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  for (const conn of activeTunnels.values()) {
    if (conn.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

module.exports = {
  setupDeviceTunnelServer,
  sendDeviceCommandViaTunnel,
  isDeviceTunnelOnline,
};
