const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HOST = process.env.HOST || "192.168.123.244";
const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const SERIAL_DEVICE =
  process.env.SERIAL_DEVICE ||
  "/dev/serial/by-id/usb-Arduino__www.arduino.cc__0043_44231313430351710192-if00";
const SERIAL_BAUD = process.env.SERIAL_BAUD || "115200";
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 1000);
const STATE_FILE = path.join(ROOT, "waterbowl-state.json");
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const CONSUMPTION_NOISE_ML = 2;
const allowedCommands = new Set([
  "RUN",
  "STOP",
  "TARE",
  "SET_MIN",
  "SET_MAX",
]);
const serialClients = new Set();
let serialBuffer = "";
let serialStream = null;
let serialWriter = null;
let serialStatus = "SERIAL STARTING";
let heartbeatTimer = null;
let reconnectTimer = null;
let serialOpening = false;
let consumptionEvents = [];
let lastWaterMl = null;
let saveStateTimer = null;
let telemetryIgnoreUntil = 0;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, headers);
  response.end(body);
}

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl, `http://${HOST}:${PORT}`);
  const requestedPath = decodeURIComponent(url.pathname);
  const filePath = requestedPath === "/" ? "/index.html" : requestedPath;
  const resolvedPath = path.resolve(ROOT, `.${filePath}`);

  if (!resolvedPath.startsWith(ROOT)) {
    return null;
  }

  return resolvedPath;
}

function broadcastSerialLine(line) {
  const payload = `data: ${JSON.stringify({ line, timestamp: Date.now() })}\n\n`;

  for (const client of serialClients) {
    client.write(payload);
  }
}

function parseKeyValueLine(line) {
  const [type, ...parts] = line.split(",");
  const values = { type };

  for (const part of parts) {
    const separator = part.indexOf("=");

    if (separator !== -1) {
      values[part.slice(0, separator)] = part.slice(separator + 1);
    }
  }

  return values;
}

function loadConsumptionState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    consumptionEvents = Array.isArray(state.consumptionEvents) ? state.consumptionEvents : [];
  } catch {
    consumptionEvents = [];
  }
}

function saveConsumptionStateSoon() {
  if (saveStateTimer) {
    return;
  }

  saveStateTimer = setTimeout(() => {
    saveStateTimer = null;
    const state = JSON.stringify({ consumptionEvents }, null, 2);
    fs.writeFile(`${STATE_FILE}.tmp`, state, (writeError) => {
      if (writeError) {
        console.error(`Could not save consumption state: ${writeError.message}`);
        return;
      }

      fs.rename(`${STATE_FILE}.tmp`, STATE_FILE, (renameError) => {
        if (renameError) {
          console.error(`Could not replace consumption state: ${renameError.message}`);
        }
      });
    });
  }, 500);
}

function saveConsumptionStateNow() {
  const state = JSON.stringify({ consumptionEvents }, null, 2);
  fs.writeFileSync(`${STATE_FILE}.tmp`, state);
  fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
}

function pruneConsumptionEvents(now = Date.now()) {
  consumptionEvents = consumptionEvents.filter((event) => now - event.timestamp <= WEEK_MS);
}

function consumptionStats(now = Date.now()) {
  pruneConsumptionEvents(now);

  return consumptionEvents.reduce(
    (stats, event) => {
      if (now - event.timestamp <= DAY_MS) {
        stats.water24hMl += event.ml;
      }

      stats.water7dMl += event.ml;
      return stats;
    },
    { water24hMl: 0, water7dMl: 0 },
  );
}

function statsLine() {
  const stats = consumptionStats();
  return `STAT,water_24h_ml=${Math.round(stats.water24hMl)},water_7d_ml=${Math.round(stats.water7dMl)}`;
}

function processSerialLine(line) {
  const values = parseKeyValueLine(line);

  if (values.type !== "TEL") {
    return;
  }

  const waterMl = Number(values.water_ml);

  if (!Number.isFinite(waterMl)) {
    return;
  }

  if (Date.now() < telemetryIgnoreUntil) {
    lastWaterMl = waterMl;
    return;
  }

  if (lastWaterMl !== null) {
    const consumedMl = lastWaterMl - waterMl;

    if (consumedMl > CONSUMPTION_NOISE_ML) {
      consumptionEvents.push({ ml: consumedMl, timestamp: Date.now() });
      pruneConsumptionEvents();
      saveConsumptionStateSoon();
      broadcastSerialLine(statsLine());
    }
  }

  lastWaterMl = waterMl;
}

function setSerialStatus(status) {
  serialStatus = status;
  console.log(status);
  broadcastSerialLine(status);
}

function cleanupSerial() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (serialStream) {
    serialStream.removeAllListeners();
    serialStream.destroy();
    serialStream = null;
  }

  if (serialWriter) {
    serialWriter.removeAllListeners();
    serialWriter.destroy();
    serialWriter = null;
  }

  serialBuffer = "";
}

function scheduleSerialReconnect(reason) {
  cleanupSerial();
  setSerialStatus(`SERIAL RECONNECTING: ${reason}`);

  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startSerialReader();
  }, 2000);
}

function writeSerialCommand(command) {
  if (!serialWriter || serialWriter.destroyed) {
    console.error(`Command rejected, serial writer is not ready: ${command}`);
    return false;
  }

  const line = `${command}\n`;

  if (command === "TARE" || command === "SET_MIN" || command === "SET_MAX") {
    telemetryIgnoreUntil = Date.now() + 3000;
  }

  serialWriter.write(line, (error) => {
    if (error) {
      scheduleSerialReconnect(`write failed: ${error.message}`);
    }
  });

  console.log(`Serial command written: ${command}`);
  broadcastSerialLine(`CMD,source=pi,command=${command}`);
  return true;
}

function readRequestBody(request, callback) {
  let body = "";

  request.on("data", (chunk) => {
    body += chunk;

    if (body.length > 1024) {
      request.destroy();
    }
  });

  request.on("end", () => callback(body));
}

function startSerialReader() {
  if (serialOpening) {
    return;
  }

  serialOpening = true;
  setSerialStatus(`SERIAL OPENING: ${SERIAL_DEVICE}`);

  const configure = spawn("stty", [
    "-F",
    SERIAL_DEVICE,
    SERIAL_BAUD,
    "cs8",
    "-cstopb",
    "-parenb",
    "-ixon",
    "-ixoff",
    "raw",
    "-echo",
  ]);

  configure.on("exit", (code) => {
    serialOpening = false;

    if (code !== 0) {
      scheduleSerialReconnect(`could not configure ${SERIAL_DEVICE}`);
      return;
    }

    serialStream = fs.createReadStream(SERIAL_DEVICE, { encoding: "utf8" });

    serialStream.on("data", (chunk) => {
      serialBuffer += chunk;
      const lines = serialBuffer.split(/\r?\n/);
      serialBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed) {
          broadcastSerialLine(trimmed);
          processSerialLine(trimmed);
        }
      }
    });

    serialStream.on("error", (error) => {
      scheduleSerialReconnect(`read failed: ${error.message}`);
    });

    serialStream.on("close", () => {
      scheduleSerialReconnect("device closed");
    });

    serialWriter = fs.createWriteStream(SERIAL_DEVICE, { flags: "w" });
    serialWriter.on("error", (error) => {
      scheduleSerialReconnect(`write failed: ${error.message}`);
    });

    serialWriter.on("close", () => {
      scheduleSerialReconnect("writer closed");
    });

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }

    heartbeatTimer = setInterval(() => {
      if (serialWriter && !serialWriter.destroyed) {
        serialWriter.write("HB\n", (error) => {
          if (error) {
            scheduleSerialReconnect(`heartbeat failed: ${error.message}`);
          }
        });
      }
    }, HEARTBEAT_INTERVAL_MS);

    setSerialStatus(`SERIAL READY: ${SERIAL_DEVICE} @ ${SERIAL_BAUD}, waiting for Arduino data`);
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);

  if (url.pathname === "/reset-counters") {
    if (request.method !== "POST") {
      send(response, 405, JSON.stringify({ error: "Method Not Allowed" }), {
        "Allow": "POST",
        "Content-Type": "application/json; charset=utf-8",
      });
      return;
    }

    consumptionEvents = [];
    lastWaterMl = null;
    saveConsumptionStateNow();
    broadcastSerialLine(statsLine());
    send(response, 200, JSON.stringify({ ok: true }), {
      "Content-Type": "application/json; charset=utf-8",
    });
    return;
  }

  if (url.pathname === "/command") {
    if (request.method !== "POST") {
      send(response, 405, JSON.stringify({ error: "Method Not Allowed" }), {
        "Allow": "POST",
        "Content-Type": "application/json; charset=utf-8",
      });
      return;
    }

    readRequestBody(request, (body) => {
      let command = "";

      try {
        command = String(JSON.parse(body).command || "").trim().toUpperCase();
      } catch {
        send(response, 400, JSON.stringify({ error: "Invalid JSON" }), {
          "Content-Type": "application/json; charset=utf-8",
        });
        return;
      }

      if (!allowedCommands.has(command)) {
        send(response, 400, JSON.stringify({ error: "Unsupported command" }), {
          "Content-Type": "application/json; charset=utf-8",
        });
        return;
      }

      if (!writeSerialCommand(command)) {
        send(response, 503, JSON.stringify({ error: "Serial writer is not ready" }), {
          "Content-Type": "application/json; charset=utf-8",
        });
        return;
      }

      send(response, 200, JSON.stringify({ ok: true, command }), {
        "Content-Type": "application/json; charset=utf-8",
      });
    });
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
    return;
  }

  if (url.pathname === "/events") {
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream",
    });
    response.write(`data: ${JSON.stringify({ line: "SERIAL CONNECTED", timestamp: Date.now() })}\n\n`);
    response.write(`data: ${JSON.stringify({ line: serialStatus, timestamp: Date.now() })}\n\n`);
    response.write(`data: ${JSON.stringify({ line: statsLine(), timestamp: Date.now() })}\n\n`);
    serialClients.add(response);
    request.on("close", () => serialClients.delete(response));
    return;
  }

  const filePath = resolveRequestPath(request.url);

  if (!filePath) {
    send(response, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(response, 404, "Not Found");
      return;
    }

    const contentType = mimeTypes[path.extname(filePath)] || "application/octet-stream";
    const headers = {
      "Cache-Control": "no-cache",
      "Content-Type": contentType,
    };

    send(response, 200, request.method === "HEAD" ? "" : data, headers);
  });
});

server.listen(PORT, HOST, () => {
  loadConsumptionState();
  console.log(`Water Bowl PWA running at http://${HOST}:${PORT}`);
  console.log(`Reading serial from ${SERIAL_DEVICE} at ${SERIAL_BAUD} baud`);
  startSerialReader();
});
