#include "HX711.h"
#include <EEPROM.h>
#include <ctype.h>
#include <string.h>

// -------- HX711 pins
#define HX_DT 4
#define HX_SCK 5
HX711 scale;

// -------- Controls
const int TARE_BUTTON_PIN = 2; // Button to GND, uses INPUT_PULLUP
const int CAL_BUTTON_PIN = 3;  // Button to GND, uses INPUT_PULLUP
const int SERIAL_RX_LED_PIN = LED_BUILTIN;

// -------- Scale calibration
long offset = 0;
float scaleFactor = 314.0f;  // Replace with your suggested SCALE_FACTOR.

// -------- Timing
unsigned long tPrint = 0;
unsigned long tScaleRead = 0;
unsigned long lastPiHeartbeat = 0;
const unsigned long SCALE_READ_INTERVAL_MS = 100; // HX711 default rate is about 10 readings/second.
const unsigned long PRINT_INTERVAL_MS = 500;
const unsigned long SERIAL_WATCHDOG_TIMEOUT_MS = 5000;
const unsigned long DEBOUNCE_MS = 35;
const long ZERO_NOISE_ML = 3;
const bool REQUIRE_PI_HEARTBEAT_TO_OPEN_VALVE = false; // Testing only. Set true for fail-safe mode.
const uint32_t SETTINGS_MAGIC = 0x57415452UL; // "WATR"

struct StoredSettings {
  uint32_t magic;
  long offset;
  long minMl;
  long maxMl;
};

enum SystemState {
  CAL_TARE,
  CAL_MIN,
  CAL_MAX,
  NORMAL
};

SystemState state = CAL_TARE;

float waterGrams = 0.0f;
long waterMl = 0;
long minMl = 0;
long maxMl = 0;
bool runEnabled = true;
bool valveOpen = false; // Pi-owned in Phase 1; kept in telemetry for protocol compatibility.
bool piConnected = false;
bool settingsLoaded = false;

struct DebouncedButton {
  uint8_t pin;
  bool stable;
  bool lastReading;
  unsigned long tChange;
};

DebouncedButton tareButton = {TARE_BUTTON_PIN, false, false, 0};
DebouncedButton calButton = {CAL_BUTTON_PIN, false, false, 0};

char serialLine[40];
uint8_t serialLinePos = 0;

const __FlashStringHelper* stateName(SystemState s) {
  switch (s) {
    case CAL_TARE: return F("CAL_TARE");
    case CAL_MIN: return F("CAL_MIN");
    case CAL_MAX: return F("CAL_MAX");
    case NORMAL: return F("NORMAL");
  }

  return F("UNKNOWN");
}

void printTelemetry(bool force);
void printEvent(const __FlashStringHelper* name);
void enterState(SystemState nextState);
void printCalibrationReading(const __FlashStringHelper* label);

bool serialWatchdogOk() {
  return piConnected && (millis() - lastPiHeartbeat <= SERIAL_WATCHDOG_TIMEOUT_MS);
}

bool settingsAreValid(const StoredSettings& settings) {
  return settings.magic == SETTINGS_MAGIC &&
         settings.minMl >= 0 &&
         settings.maxMl > settings.minMl &&
         settings.maxMl <= 10000;
}

bool loadSettings() {
  StoredSettings settings;
  EEPROM.get(0, settings);

  if (!settingsAreValid(settings)) return false;

  offset = settings.offset;
  minMl = settings.minMl;
  maxMl = settings.maxMl;
  settingsLoaded = true;
  return true;
}

void saveSettings() {
  StoredSettings settings = {SETTINGS_MAGIC, offset, minMl, maxMl};
  EEPROM.put(0, settings);
  settingsLoaded = true;
  printEvent(F("SETTINGS_SAVED"));
}

void resetSettings() {
  StoredSettings settings = {0, 0, 0, 0};
  EEPROM.put(0, settings);
  settingsLoaded = false;
  minMl = 0;
  maxMl = 0;
  printEvent(F("SETTINGS_RESET"));
}

void printEvent(const __FlashStringHelper* name) {
  Serial.print(F("EVT,ms="));
  Serial.print(millis());
  Serial.print(F(",name="));
  Serial.print(name);
  Serial.print(F(",state="));
  Serial.print(stateName(state));
  Serial.print(F(",water_ml="));
  Serial.print(waterMl);
  Serial.print(F(",min_ml="));
  Serial.print(minMl);
  Serial.print(F(",max_ml="));
  Serial.print(maxMl);
  Serial.print(F(",run="));
  Serial.print(runEnabled ? 1 : 0);
  Serial.print(F(",pi="));
  Serial.print(serialWatchdogOk() ? 1 : 0);
  Serial.print(F(",settings="));
  Serial.print(settingsLoaded ? 1 : 0);
  Serial.print(F(",valve="));
  Serial.println(valveOpen ? 1 : 0);
}

void logStateChange(SystemState fromState, SystemState toState) {
  Serial.print(F("EVT,ms="));
  Serial.print(millis());
  Serial.print(F(",name=STATE_CHANGE,from="));
  Serial.print(stateName(fromState));
  Serial.print(F(",to="));
  Serial.print(stateName(toState));
  Serial.print(F(",water_ml="));
  Serial.print(waterMl);
  Serial.print(F(",min_ml="));
  Serial.print(minMl);
  Serial.print(F(",max_ml="));
  Serial.print(maxMl);
  Serial.print(F(",settings="));
  Serial.println(settingsLoaded ? 1 : 0);
}

void setRunEnabled(bool enabled, const __FlashStringHelper* reason) {
  if (runEnabled == enabled) return;

  runEnabled = enabled;
  Serial.print(F("EVT,ms="));
  Serial.print(millis());
  Serial.print(F(",name="));
  Serial.print(enabled ? F("RUN_ENABLED") : F("RUN_DISABLED"));
  Serial.print(F(",reason="));
  Serial.print(reason);
  Serial.print(F(",run="));
  Serial.println(runEnabled ? 1 : 0);
}

void tareScale() {
  printEvent(F("TARE_START"));

  delay(500);
  offset = scale.read_average(30);
  waterGrams = 0.0f;
  waterMl = 0;

  Serial.print(F("EVT,ms="));
  Serial.print(millis());
  Serial.print(F(",name=TARE_DONE,offset="));
  Serial.print(offset);
  Serial.print(F(",scale_factor="));
  Serial.print(scaleFactor, 2);
  Serial.print(F(",state="));
  Serial.print(stateName(state));
  Serial.print(F(",water_ml="));
  Serial.print(waterMl);
  Serial.print(F(",min_ml="));
  Serial.print(minMl);
  Serial.print(F(",max_ml="));
  Serial.print(maxMl);
  Serial.print(F(",settings="));
  Serial.println(settingsLoaded ? 1 : 0);
}

void setCurrentMin() {
  minMl = waterMl;
  printEvent(F("MIN_SET"));
  enterState(CAL_MAX);
}

void setCurrentMax() {
  maxMl = waterMl;
  if (maxMl <= minMl) {
    printEvent(F("MAX_REJECTED_NOT_GREATER_THAN_MIN"));
    return;
  }

  printEvent(F("MAX_SET"));
  saveSettings();
  enterState(NORMAL);
}

bool readButtonPressed(DebouncedButton& button, const __FlashStringHelper* eventName) {
  bool reading = (digitalRead(button.pin) == LOW);
  unsigned long now = millis();

  if (reading != button.lastReading) {
    button.lastReading = reading;
    button.tChange = now;
  }

  if ((now - button.tChange) >= DEBOUNCE_MS && reading != button.stable) {
    button.stable = reading;
    if (button.stable) {
      printEvent(eventName);
      return true;
    }
  }

  return false;
}

bool updateWaterReading() {
  unsigned long now = millis();
  if (now - tScaleRead < SCALE_READ_INTERVAL_MS) {
    return false;
  }
  tScaleRead = now;

  if (!scale.is_ready()) return false;

  long raw = scale.read();
  long diff = raw - offset;

  float gramsF = diff / scaleFactor; // Water: 1 gram ~= 1 milliliter
  if (!isfinite(gramsF) || fabs(gramsF) > 1000000.0f) gramsF = 0;

  waterGrams = gramsF;
  long ml = lroundf(gramsF);
  if (ml < ZERO_NOISE_ML) ml = 0;

  waterMl = ml;
  return true;
}

void enterState(SystemState nextState) {
  SystemState previousState = state;
  state = nextState;

  logStateChange(previousState, nextState);

  switch (state) {
    case CAL_TARE:
      printEvent(F("NEED_TARE"));
      break;
    case CAL_MIN:
      printEvent(F("NEED_MIN"));
      break;
    case CAL_MAX:
      printEvent(F("NEED_MAX"));
      break;
    case NORMAL:
      printEvent(F("CAL_DONE"));
      break;
  }
}

void handleSerialCommand(char* command) {
  for (uint8_t i = 0; command[i] != '\0'; i++) {
    command[i] = toupper((unsigned char)command[i]);
  }

  Serial.print(F("RXCMD,ms="));
  Serial.print(millis());
  Serial.print(F(",command="));
  Serial.println(command);

  if (strcmp(command, "HB") == 0) {
    lastPiHeartbeat = millis();
    if (!piConnected) {
      piConnected = true;
      printEvent(F("PI_CONNECTED"));
    }
    Serial.print(F("ACK,ms="));
    Serial.println(millis());
  } else if (strcmp(command, "TARE") == 0 || strcmp(command, "T") == 0) {
    printEvent(F("SERIAL_TARE"));
    tareScale();
    if (state == CAL_TARE) {
      enterState(CAL_MIN);
    } else if (settingsLoaded && state == NORMAL) {
      saveSettings();
    }
  } else if (strcmp(command, "SET_MIN") == 0) {
    printEvent(F("SERIAL_SET_MIN"));
    setCurrentMin();
  } else if (strcmp(command, "SET_MAX") == 0) {
    printEvent(F("SERIAL_SET_MAX"));
    setCurrentMax();
  } else {
    printEvent(F("UNKNOWN_COMMAND"));
  }
}

void handleSerial() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    digitalWrite(SERIAL_RX_LED_PIN, !digitalRead(SERIAL_RX_LED_PIN));

    if (c == '\n' || c == '\r') {
      serialLine[serialLinePos] = '\0';
      if (serialLinePos > 0) handleSerialCommand(serialLine);
      serialLinePos = 0;
    } else if (isprint((unsigned char)c) && serialLinePos < sizeof(serialLine) - 1) {
      serialLine[serialLinePos++] = c;
    } else {
      serialLinePos = 0;
      printEvent(F("SERIAL_LINE_TOO_LONG"));
    }
  }
}

void updateSerialWatchdog() {
  if (piConnected && !serialWatchdogOk()) {
    piConnected = false;
    printEvent(F("PI_TIMEOUT"));
  }
}

void handleCalibrationTare() {
  printCalibrationReading(F("TARE"));
}

void printCalibrationReading(const __FlashStringHelper* label) {
  unsigned long now = millis();
  if (now - tPrint < PRINT_INTERVAL_MS) return;
  tPrint = now;

  Serial.print(F("CAL,ms="));
  Serial.print(millis());
  Serial.print(F(",step="));
  Serial.print(label);
  Serial.print(F(",water_ml="));
  Serial.print(waterMl);
  Serial.print(F(",grams="));
  Serial.println(waterGrams, 2);
}

void handleCalibrationMin(bool buttonPressed) {
  printCalibrationReading(F("MIN"));

  if (buttonPressed) {
    setCurrentMin();
  }
}

void handleCalibrationMax(bool buttonPressed) {
  printCalibrationReading(F("FILL"));

  if (buttonPressed) {
    setCurrentMax();
  }
}

void updateValveControl() {
  // Phase 1: the Raspberry Pi owns solenoid control through the RELAYplate.
  valveOpen = false;
}

void printTelemetry(bool force) {
  unsigned long now = millis();
  if (!force && now - tPrint < PRINT_INTERVAL_MS) return;
  tPrint = now;

  Serial.print(F("TEL,ms="));
  Serial.print(now);
  Serial.print(F(",state="));
  Serial.print(stateName(state));
  Serial.print(F(",water_ml="));
  Serial.print(waterMl);
  Serial.print(F(",grams="));
  Serial.print(waterGrams, 2);
  Serial.print(F(",min_ml="));
  Serial.print(minMl);
  Serial.print(F(",max_ml="));
  Serial.print(maxMl);
  Serial.print(F(",run="));
  Serial.print(runEnabled ? 1 : 0);
  Serial.print(F(",pi="));
  Serial.print(serialWatchdogOk() ? 1 : 0);
  Serial.print(F(",settings="));
  Serial.print(settingsLoaded ? 1 : 0);
  Serial.print(F(",valve="));
  Serial.println(valveOpen ? 1 : 0);
}

void handleNormal(bool calPressed) {
  if (calPressed) {
    printEvent(F("CALIBRATE_BUTTON"));
    enterState(CAL_TARE);
    return;
  }

  updateValveControl();
  printTelemetry(false);
}

void setup() {
  Serial.begin(115200);

  pinMode(TARE_BUTTON_PIN, INPUT_PULLUP);
  pinMode(CAL_BUTTON_PIN, INPUT_PULLUP);
  pinMode(SERIAL_RX_LED_PIN, OUTPUT);
  digitalWrite(SERIAL_RX_LED_PIN, LOW);

  scale.begin(HX_DT, HX_SCK);
  scale.set_gain(128);          // Channel A, same as the calibration sketch
  delay(1000);

  if (!scale.is_ready()) {
    Serial.println(F("ERR,ms=0,name=HX711_NOT_READY"));
    while (1);
  }

  printEvent(F("BOOT"));
  Serial.println(F("INFO,protocol=1,commands=HB|TARE|SET_MIN|SET_MAX"));

  if (loadSettings() && digitalRead(CAL_BUTTON_PIN) == HIGH) {
    printEvent(F("SETTINGS_LOADED"));
    enterState(NORMAL);
  } else {
    printEvent(F("CAL_REQUIRED"));
    enterState(CAL_TARE);
  }
}

void loop() {
  handleSerial();
  updateSerialWatchdog();
  updateWaterReading();

  bool tarePressed = readButtonPressed(tareButton, F("TARE_BUTTON"));
  bool calPressed = readButtonPressed(calButton, F("CAL_BUTTON"));

  if (tarePressed) {
    tareScale();
    if (state == CAL_TARE) {
      enterState(CAL_MIN);
    } else if (settingsLoaded && state == NORMAL) {
      saveSettings();
    }
  }

  switch (state) {
    case CAL_TARE:
      handleCalibrationTare();
      break;
    case CAL_MIN:
      handleCalibrationMin(calPressed);
      break;
    case CAL_MAX:
      handleCalibrationMax(calPressed);
      break;
    case NORMAL:
      handleNormal(calPressed);
      break;
  }
}
