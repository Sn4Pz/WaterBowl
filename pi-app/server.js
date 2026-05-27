const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HOST = process.env.HOST || "192.168.123.244";
const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, "waterbowl-state.json");
const HX711_STATE_FILE = path.join(ROOT, "hx711-state.json");
const HX711_DATA_GPIO = Number(process.env.HX711_DATA_GPIO || 5);
const HX711_CLOCK_GPIO = Number(process.env.HX711_CLOCK_GPIO || 6);
const HX711_READER_PYTHON = process.env.HX711_READER_PYTHON || "/usr/bin/python3";
const HX711_READER_SCRIPT = path.join(ROOT, "hx711_reader.py");
const RELAYPLATE_PYTHON =
  process.env.RELAYPLATE_PYTHON || path.join(ROOT, ".venv", "bin", "python");
const RELAYPLATE_ADDRESS = Number(process.env.RELAYPLATE_ADDRESS || 0);
const RELAYPLATE_RELAYS = (process.env.RELAYPLATE_RELAYS || "1,2")
  .split(",")
  .map((relay) => Number(relay.trim()))
  .filter((relay) => Number.isInteger(relay) && relay >= 1 && relay <= 7);
const TELEMETRY_STALE_MS = Number(process.env.TELEMETRY_STALE_MS || 6000);
const VALVE_OPEN_CONFIRM_READINGS = Number(process.env.VALVE_OPEN_CONFIRM_READINGS || 2);
const VALVE_OPEN_DELAY_MS = Number(process.env.VALVE_OPEN_DELAY_MS || 5000);
const BOWL_REMOVED_BELOW_TARE_ML = Number(process.env.BOWL_REMOVED_BELOW_TARE_ML || 50);
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
let readerBuffer = "";
let scaleReader = null;
let readerStatus = `HX711 STARTING: DT=GPIO${HX711_DATA_GPIO}, SCK=GPIO${HX711_CLOCK_GPIO}`;
let readerRestartTimer = null;
let consumptionEvents = [];
let lastWaterMl = null;
let latestTelemetry = null;
let lastTelemetryAt = 0;
let saveStateTimer = null;
let telemetryIgnoreUntil = 0;
let piRunEnabled = true;
let piValveOpen = false;
let relayBusy = false;
let relayTargetOpen = false;
let lowReadingCount = 0;
let bowlRemoved = false;
let valveOpenRequestedAt = null;

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

function lineFromValues(values) {
  const parts = [values.type];

  for (const [key, value] of Object.entries(values)) {
    if (key !== "type") {
      parts.push(`${key}=${value}`);
    }
  }

  return parts.join(",");
}

function relayCommand(open) {
  const method = open ? "relayON" : "relayOFF";
  const commands = RELAYPLATE_RELAYS.map(
    (relay) => `RELAY.${method}(${RELAYPLATE_ADDRESS}, ${relay})`,
  );

  return [
    "-c",
    [
      "import piplates.RELAYplate as RELAY",
      ...commands,
    ].join("; "),
  ];
}

function applyRelayTarget() {
  if (RELAYPLATE_RELAYS.length === 0) {
    setReaderStatus("RELAY ERROR: no RELAYPLATE_RELAYS configured");
    return;
  }

  if (relayBusy) {
    return;
  }

  if (piValveOpen === relayTargetOpen) {
    return;
  }

  relayBusy = true;
  const target = relayTargetOpen;
  const relay = spawn(RELAYPLATE_PYTHON, relayCommand(target));
  let errorOutput = "";

  relay.stderr.on("data", (chunk) => {
    errorOutput += chunk.toString();
  });

  relay.on("error", (error) => {
    relayBusy = false;
    setReaderStatus(`RELAY ERROR: ${error.message}`);
    applyRelayTarget();
  });

  relay.on("exit", (code) => {
    relayBusy = false;

    if (code === 0) {
      piValveOpen = target;
      broadcastSerialLine(`EVT,source=pi,name=${target ? "VALVE_OPEN" : "VALVE_CLOSED"},valve=${target ? 1 : 0}`);
    } else {
      setReaderStatus(`RELAY ERROR: ${errorOutput.trim() || `exit ${code}`}`);
    }

    applyRelayTarget();
  });
}

function setPiValve(open, reason, force = false) {
  if (!open) {
    cancelPendingValveOpen(reason);
  }

  if (force) {
    piValveOpen = !open;
  }

  if (relayTargetOpen === open && piValveOpen === open) {
    return;
  }

  relayTargetOpen = open;
  console.log(`Pi relay target ${open ? "open" : "closed"}: ${reason}`);
  applyRelayTarget();
}

function setBowlRemoved(removed) {
  if (bowlRemoved === removed) {
    return;
  }

  bowlRemoved = removed;
  broadcastSerialLine(`EVT,source=pi,name=${removed ? "BOWL_REMOVED" : "BOWL_REPLACED"}`);
}

function cancelPendingValveOpen(reason) {
  if (valveOpenRequestedAt !== null) {
    valveOpenRequestedAt = null;
    broadcastSerialLine(`EVT,source=pi,name=VALVE_OPEN_CANCELLED,reason=${reason}`);
  }
}

function updatePiValveControl(reason) {
  if (!latestTelemetry) {
    lowReadingCount = 0;
    cancelPendingValveOpen("no_telemetry");
    setPiValve(false, "no telemetry");
    return;
  }

  const waterMl = Number(latestTelemetry.water_ml);
  const minMl = Number(latestTelemetry.min_ml);
  const maxMl = Number(latestTelemetry.max_ml);
  const grams = Number(latestTelemetry.grams);
  const settingsLoaded = Number(latestTelemetry.settings) === 1;
  const bowlRemovedNow = Number.isFinite(grams) && grams <= -BOWL_REMOVED_BELOW_TARE_ML;

  setBowlRemoved(bowlRemovedNow);

  if (
    !piRunEnabled ||
    !settingsLoaded ||
    bowlRemovedNow ||
    Date.now() - lastTelemetryAt > TELEMETRY_STALE_MS
  ) {
    lowReadingCount = 0;
    cancelPendingValveOpen(bowlRemovedNow ? "bowl_removed" : "unsafe");
    setPiValve(false, reason);
    return;
  }

  if (!Number.isFinite(waterMl) || !Number.isFinite(minMl) || !Number.isFinite(maxMl)) {
    lowReadingCount = 0;
    cancelPendingValveOpen("invalid_telemetry");
    setPiValve(false, "invalid telemetry");
    return;
  }

  if (waterMl <= minMl) {
    lowReadingCount += 1;

    if (!piValveOpen && lowReadingCount >= VALVE_OPEN_CONFIRM_READINGS) {
      if (valveOpenRequestedAt === null) {
        valveOpenRequestedAt = Date.now();
        broadcastSerialLine(`EVT,source=pi,name=VALVE_OPEN_PENDING,delay_ms=${VALVE_OPEN_DELAY_MS}`);
        return;
      }

      if (Date.now() - valveOpenRequestedAt >= VALVE_OPEN_DELAY_MS) {
        valveOpenRequestedAt = null;
        setPiValve(true, `below min for ${lowReadingCount} readings after delay`);
      }
    }
  } else if (piValveOpen && waterMl >= maxMl) {
    lowReadingCount = 0;
    cancelPendingValveOpen("at_max");
    setPiValve(false, "at max");
  } else if (waterMl > minMl) {
    lowReadingCount = 0;
    cancelPendingValveOpen("level_recovered");
  }
}

function processSerialLine(line) {
  const values = parseKeyValueLine(line);

  if (values.type !== "TEL") {
    return line;
  }

  const waterMl = Number(values.water_ml);

  if (!Number.isFinite(waterMl)) {
    return line;
  }

  latestTelemetry = values;
  lastTelemetryAt = Date.now();
  values.run = piRunEnabled ? 1 : 0;
  values.valve = piValveOpen ? 1 : 0;
  updatePiValveControl("telemetry");
  values.state = bowlRemoved ? "BOWL_REMOVED" : values.state;
  values.valve = piValveOpen ? 1 : 0;

  if (Date.now() < telemetryIgnoreUntil) {
    lastWaterMl = waterMl;
    return lineFromValues(values);
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
  return lineFromValues(values);
}

function setReaderStatus(status) {
  readerStatus = status;
  console.log(status);
  broadcastSerialLine(status);
}

function scheduleReaderRestart(reason) {
  setPiValve(false, "scale reader restart", true);
  setReaderStatus(`HX711 RESTARTING: ${reason}`);

  if (readerRestartTimer) {
    return;
  }

  if (scaleReader) {
    scaleReader.removeAllListeners();
    scaleReader.kill();
    scaleReader = null;
  }

  readerRestartTimer = setTimeout(() => {
    readerRestartTimer = null;
    startScaleReader();
  }, 2000);
}

function writeScaleCommand(command) {
  if (!scaleReader || !scaleReader.stdin.writable) {
    console.error(`Command rejected, scale reader is not ready: ${command}`);
    return false;
  }

  const line = `${command}\n`;

  if (command === "TARE" || command === "SET_MIN" || command === "SET_MAX") {
    telemetryIgnoreUntil = Date.now() + 3000;
  }

  scaleReader.stdin.write(line, (error) => {
    if (error) {
      scheduleReaderRestart(`write failed: ${error.message}`);
    }
  });

  console.log(`Scale command written: ${command}`);
  broadcastSerialLine(`CMD,source=pi,command=${command}`);
  return true;
}

function handlePiCommand(command) {
  if (command === "RUN") {
    piRunEnabled = true;
    broadcastSerialLine("CMD,source=pi,command=RUN");
    broadcastSerialLine("EVT,source=pi,name=RUN_ENABLED,run=1");
    updatePiValveControl("run enabled");
    return true;
  }

  if (command === "STOP") {
    piRunEnabled = false;
    broadcastSerialLine("CMD,source=pi,command=STOP");
    broadcastSerialLine("EVT,source=pi,name=RUN_DISABLED,run=0");
    setPiValve(false, "stop command");
    return true;
  }

  return false;
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

function startScaleReader() {
  if (scaleReader) {
    return;
  }

  setReaderStatus(`HX711 OPENING: DT=GPIO${HX711_DATA_GPIO}, SCK=GPIO${HX711_CLOCK_GPIO}`);
  readerBuffer = "";
  scaleReader = spawn(HX711_READER_PYTHON, [HX711_READER_SCRIPT], {
    cwd: ROOT,
    env: {
      ...process.env,
      HX711_DATA_GPIO: String(HX711_DATA_GPIO),
      HX711_CLOCK_GPIO: String(HX711_CLOCK_GPIO),
      HX711_STATE_FILE,
    },
  });

  scaleReader.stdout.on("data", (chunk) => {
    readerBuffer += chunk.toString();
    const lines = readerBuffer.split(/\r?\n/);
    readerBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed) {
        broadcastSerialLine(processSerialLine(trimmed));
      }
    }
  });

  scaleReader.stderr.on("data", (chunk) => {
    console.error(chunk.toString().trim());
  });

  scaleReader.on("error", (error) => {
    scaleReader = null;
    scheduleReaderRestart(error.message);
  });

  scaleReader.on("exit", (code) => {
    scaleReader = null;
    scheduleReaderRestart(`reader exited ${code}`);
  });

  setReaderStatus(`HX711 READY: DT=GPIO${HX711_DATA_GPIO}, SCK=GPIO${HX711_CLOCK_GPIO}`);
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

      if (handlePiCommand(command)) {
        send(response, 200, JSON.stringify({ ok: true, command }), {
          "Content-Type": "application/json; charset=utf-8",
        });
        return;
      }

      if (!writeScaleCommand(command)) {
        send(response, 503, JSON.stringify({ error: "Scale reader is not ready" }), {
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
    response.write(`data: ${JSON.stringify({ line: "SCALE CONNECTED", timestamp: Date.now() })}\n\n`);
    response.write(`data: ${JSON.stringify({ line: readerStatus, timestamp: Date.now() })}\n\n`);
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
  console.log(`Reading HX711 on DT=GPIO${HX711_DATA_GPIO}, SCK=GPIO${HX711_CLOCK_GPIO}`);
  console.log(`Controlling valve with RELAYplate K${RELAYPLATE_RELAYS.join(" + K")}`);
  startScaleReader();
  setPiValve(false, "server startup", true);
  setInterval(() => updatePiValveControl("telemetry stale check"), 1000);
});
