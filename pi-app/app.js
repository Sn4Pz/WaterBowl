const elements = {
  clearLog: document.querySelector("#clearLog"),
  commandFeedback: document.querySelector("#commandFeedback"),
  connectionStatus: document.querySelector("#connectionStatus"),
  consumed24h: document.querySelector("#consumed24h"),
  consumed7d: document.querySelector("#consumed7d"),
  fillPercent: document.querySelector("#fillPercent"),
  lastUpdate: document.querySelector("#lastUpdate"),
  latestEvent: document.querySelector("#latestEvent"),
  maxMl: document.querySelector("#maxMl"),
  minMl: document.querySelector("#minMl"),
  piStatus: document.querySelector("#piStatus"),
  resetCounters: document.querySelector("#resetCounters"),
  runStatus: document.querySelector("#runStatus"),
  telemetryLog: document.querySelector("#telemetryLog"),
  settingsStatus: document.querySelector("#settingsStatus"),
  stateChip: document.querySelector("#stateChip"),
  systemState: document.querySelector("#systemState"),
  valveStatus: document.querySelector("#valveStatus"),
  volumeMl: document.querySelector("#volumeMl"),
  waterFill: document.querySelector("#waterFill"),
  waterMl: document.querySelector("#waterMl"),
};

const telemetryLines = [];
const maxTelemetryLines = 240;
const streamStaleAfterMs = 6000;
let lastStreamMessageAt = 0;
let lastStreamErrorAt = 0;
const telemetry = {
  grams: null,
  maxMl: null,
  minMl: null,
  pi: null,
  run: null,
  settings: null,
  state: null,
  valve: null,
  waterMl: null,
  water24hMl: 0,
  water7dMl: 0,
};
const commandLabels = {
  RUN: "Start",
  SET_MAX: "Set Max",
  SET_MIN: "Set Min",
  STOP: "Stop",
  TARE: "Tare",
};

function formatClock() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function parseTelemetryLine(line) {
  const [type, ...parts] = line.split(",");
  const values = { type };

  for (const part of parts) {
    const separator = part.indexOf("=");

    if (separator === -1) {
      continue;
    }

    values[part.slice(0, separator)] = part.slice(separator + 1);
  }

  return values;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mlValue(value) {
  return value === null ? "--" : Math.round(value);
}

function setTileState(element, isGood, isWarn = false) {
  const tile = element.closest(".status-tile");

  if (!tile) {
    return;
  }

  tile.classList.toggle("good", Boolean(isGood));
  tile.classList.toggle("warn", Boolean(isWarn));
  tile.classList.toggle("bad", !isGood && !isWarn);
}

function updateConnection(label, mode = "online") {
  elements.connectionStatus.classList.toggle("online", mode === "online");
  elements.connectionStatus.classList.toggle("offline", mode === "offline");
  elements.connectionStatus.lastChild.textContent = ` ${label}`;
}

function markStreamOnline() {
  lastStreamMessageAt = Date.now();
  updateConnection("Online", "online");
}

function markStreamReconnecting() {
  lastStreamErrorAt = Date.now();
  updateConnection("Reconnecting", "offline");
}

function updateDashboard() {
  const min = telemetry.minMl ?? 0;
  const max = telemetry.maxMl ?? 0;
  const water = telemetry.waterMl ?? 0;
  const fillPercent = max > min ? Math.round(((water - min) / (max - min)) * 100) : 0;
  const clampedFill = Math.max(0, Math.min(100, fillPercent));

  elements.waterMl.textContent = mlValue(telemetry.waterMl);
  elements.volumeMl.textContent = mlValue(telemetry.waterMl);
  elements.minMl.textContent = mlValue(telemetry.minMl);
  elements.maxMl.textContent = mlValue(telemetry.maxMl);
  elements.fillPercent.textContent = `${clampedFill}%`;
  elements.waterFill.style.height = `${Math.max(8, clampedFill)}%`;
  elements.lastUpdate.textContent = formatClock();
  const bowlState = telemetry.state === "BOWL_REMOVED"
    ? "BOWL REMOVED"
    : telemetry.waterMl !== null && telemetry.minMl !== null && telemetry.waterMl < telemetry.minMl
      ? "LOW"
      : telemetry.state || "Waiting";
  const isLow = bowlState === "LOW" || bowlState === "BOWL REMOVED";

  elements.systemState.textContent = bowlState;
  elements.stateChip.textContent = bowlState;
  elements.systemState.classList.toggle("low", isLow);
  elements.systemState.classList.toggle("normal", !isLow && bowlState !== "Waiting");
  elements.stateChip.classList.toggle("low", isLow);
  elements.waterFill.classList.toggle("low", isLow);

  const valveOpen = telemetry.valve === 1;
  elements.valveStatus.textContent = valveOpen ? "Open" : "Closed";
  setTileState(elements.valveStatus, !valveOpen, valveOpen);

  const running = telemetry.run === 1;
  elements.runStatus.textContent = running ? "Start" : "Stop";
  setTileState(elements.runStatus, running);

  const piLinked = telemetry.pi === 1;
  elements.piStatus.textContent = piLinked ? "Pi scale Linked" : "Unlinked";
  setTileState(elements.piStatus, piLinked);

  const settingsLoaded = telemetry.settings === 1;
  elements.settingsStatus.textContent = settingsLoaded ? "Stored" : "Not set";
  setTileState(elements.settingsStatus, settingsLoaded, !settingsLoaded);
  elements.consumed24h.textContent = telemetry.water24hMl;
  elements.consumed7d.textContent = telemetry.water7dMl;
}

function handleTelemetry(values) {
  telemetry.state = values.state || telemetry.state;
  telemetry.waterMl = numberOrNull(values.water_ml) ?? telemetry.waterMl;
  telemetry.grams = numberOrNull(values.grams) ?? telemetry.grams;
  telemetry.minMl = numberOrNull(values.min_ml) ?? telemetry.minMl;
  telemetry.maxMl = numberOrNull(values.max_ml) ?? telemetry.maxMl;
  telemetry.run = numberOrNull(values.run) ?? telemetry.run;
  telemetry.pi = numberOrNull(values.pi) ?? telemetry.pi;
  telemetry.settings = numberOrNull(values.settings) ?? telemetry.settings;
  telemetry.valve = numberOrNull(values.valve) ?? telemetry.valve;
  updateDashboard();
}

function handleStats(values) {
  telemetry.water24hMl = numberOrNull(values.water_24h_ml) ?? telemetry.water24hMl;
  telemetry.water7dMl = numberOrNull(values.water_7d_ml) ?? telemetry.water7dMl;
  updateDashboard();
}

function handleParsedLine(line) {
  const values = parseTelemetryLine(line);

  if (values.type === "TEL") {
    handleTelemetry(values);
    return;
  }

  if (values.type === "STAT") {
    handleStats(values);
    return;
  }

  if (values.type === "EVT") {
    handleTelemetry(values);
    elements.latestEvent.textContent = values.name || line;
    return;
  }

  if (values.type === "CAL") {
    handleTelemetry(values);
    elements.latestEvent.textContent = `Calibration: ${values.step || "reading"}`;
    return;
  }

  if (values.type === "CMD") {
    elements.latestEvent.textContent = `Pi sent ${values.command || "command"}`;
  }
}

function pushTelemetryLine(line) {
  const timestamp = formatClock();
  telemetryLines.push(`[${timestamp}] ${line}`);

  if (telemetryLines.length > maxTelemetryLines) {
    telemetryLines.splice(0, telemetryLines.length - maxTelemetryLines);
  }

  elements.telemetryLog.textContent = telemetryLines.join("\n");
  elements.telemetryLog.scrollTop = elements.telemetryLog.scrollHeight;
  handleParsedLine(line);
}

async function sendCommand(command) {
  const label = commandLabels[command] || command;
  elements.commandFeedback.textContent = `${label} request sent...`;

  try {
    const response = await fetch("./command", {
      body: JSON.stringify({ command }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "Command failed" }));
      throw new Error(payload.error || "Command failed");
    }

    elements.commandFeedback.textContent = `${label} request delivered`;
  } catch (error) {
    elements.commandFeedback.textContent = `${label} failed: ${error.message}`;
  }
}

async function resetCounters() {
  const confirmed = window.confirm("Reset the 24 hour and weekly water consumption counters?");

  if (!confirmed) {
    return;
  }

  elements.commandFeedback.textContent = "Resetting consumption counters...";

  try {
    const response = await fetch("./reset-counters", { method: "POST" });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "Reset failed" }));
      throw new Error(payload.error || "Reset failed");
    }

    telemetry.water24hMl = 0;
    telemetry.water7dMl = 0;
    updateDashboard();
    elements.latestEvent.textContent = "Consumption counters reset";
    elements.commandFeedback.textContent = "Consumption counters reset";
  } catch (error) {
    elements.commandFeedback.textContent = `Counter reset failed: ${error.message}`;
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // The app still works without offline caching.
    });
  });
}

const events = new EventSource("./events");

events.addEventListener("open", markStreamOnline);

events.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  markStreamOnline();
  pushTelemetryLine(message.line);
});

events.addEventListener("error", () => {
  const shouldLogError = Date.now() - lastStreamErrorAt > 3000;
  markStreamReconnecting();

  if (shouldLogError) {
    pushTelemetryLine("TELEMETRY STREAM DISCONNECTED");
  }
});

setInterval(() => {
  if (lastStreamMessageAt === 0) {
    return;
  }

  if (Date.now() - lastStreamMessageAt > streamStaleAfterMs) {
    updateConnection("Reconnecting", "offline");
  }
}, 1000);

document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    sendCommand(button.dataset.command);
  });
});

elements.clearLog.addEventListener("click", () => {
  telemetryLines.length = 0;
  elements.telemetryLog.textContent = "LOG CLEARED";
});

elements.resetCounters.addEventListener("click", resetCounters);
