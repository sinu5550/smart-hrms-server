/**
 * SmartHRM Biometric Cloud Reverse-Tunnel Relay Manager
 * ----------------------------------------------------
 * Maintains live WebSocket tunnels with on-premise local agents.
 * Enables the cloud server to make instant, real-time ISAPI calls to local LAN
 * biometric devices without public IPs or port forwarding!
 */

const WebSocket = require("ws");

// Map of deviceSerialNumber -> WebSocket connection
const activeTunnels = new Map();
// Map of correlationId -> { resolve, reject, timer }
const pendingRequests = new Map();

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
        console.error("[Tunnel Message Parse Error]", e.message);
      }
    });

    ws.on("close", () => {
      console.log(`[Tunnel Disconnected] Device serial "${serial}" tunnel closed.`);
      if (activeTunnels.get(serial) === ws) {
        activeTunnels.delete(serial);
      }
    });

    ws.on("error", (err) => {
      console.warn(`[Tunnel Error] Device serial "${serial}":`, err.message);
    });
  });

  console.log("Biometric Reverse-Tunnel Relay Server initialized at /api/devices/tunnel");
}

/**
 * Dispatch an ISAPI command through the local agent tunnel
 */
function sendDeviceCommandViaTunnel(serialNumber, { method, path, body = null, timeout = 12000 }) {
  return new Promise((resolve, reject) => {
    // Find matching tunnel
    let ws = activeTunnels.get(serialNumber);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // If exact serial not found, fallback to any active connected tunnel (for single office terminals)
      for (const [s, conn] of activeTunnels.entries()) {
        if (conn.readyState === WebSocket.OPEN) {
          ws = conn;
          break;
        }
      }
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error(`Local Agent Bridge is offline for device "${serialNumber}". Make sure SmartHRM Agent is running in the office.`));
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

