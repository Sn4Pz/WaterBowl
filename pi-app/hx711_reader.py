#!/usr/bin/env python3
import json
import math
import os
import select
import sys
import time

try:
    import gpiod
    from gpiod.line import Direction, Value
except ImportError:
    gpiod = None


CHIP_NAME = os.environ.get("HX711_GPIO_CHIP", "/dev/gpiochip0")
DATA_GPIO = int(os.environ.get("HX711_DATA_GPIO", "5"))   # Pi physical pin 29
CLOCK_GPIO = int(os.environ.get("HX711_CLOCK_GPIO", "6")) # Pi physical pin 31
STATE_FILE = os.environ.get("HX711_STATE_FILE", "hx711-state.json")
SCALE_FACTOR = float(os.environ.get("HX711_SCALE_FACTOR", "314.0"))
READ_INTERVAL_SECONDS = float(os.environ.get("HX711_READ_INTERVAL_SECONDS", "0.5"))
ZERO_NOISE_ML = int(os.environ.get("HX711_ZERO_NOISE_ML", "3"))
SETTINGS_MAGIC = "WATR"


state = "CAL_TARE"
settings_loaded = False
offset = 0
min_ml = 0
max_ml = 0
water_grams = 0.0
water_ml = 0
started_at = time.monotonic()


def millis():
    return int((time.monotonic() - started_at) * 1000)


def emit(line):
    print(line, flush=True)


def event(name, **extra):
    fields = {
        "ms": millis(),
        "name": name,
        "state": state,
        "water_ml": water_ml,
        "min_ml": min_ml,
        "max_ml": max_ml,
        "settings": 1 if settings_loaded else 0,
    }
    fields.update(extra)
    emit("EVT," + ",".join(f"{key}={value}" for key, value in fields.items()))


def telemetry(force=False):
    emit(
        "TEL,"
        f"ms={millis()},"
        f"state={state},"
        f"water_ml={water_ml},"
        f"grams={water_grams:.2f},"
        f"min_ml={min_ml},"
        f"max_ml={max_ml},"
        "run=1,"
        "pi=1,"
        f"settings={1 if settings_loaded else 0},"
        "valve=0"
    )


def load_settings():
    global offset, min_ml, max_ml, settings_loaded

    try:
        with open(STATE_FILE, "r", encoding="utf-8") as handle:
            saved = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return False

    if (
        saved.get("magic") == SETTINGS_MAGIC
        and isinstance(saved.get("offset"), int)
        and isinstance(saved.get("minMl"), int)
        and isinstance(saved.get("maxMl"), int)
        and saved["minMl"] >= 0
        and saved["maxMl"] > saved["minMl"]
    ):
        offset = saved["offset"]
        min_ml = saved["minMl"]
        max_ml = saved["maxMl"]
        settings_loaded = True
        return True

    return False


def save_settings():
    global settings_loaded

    with open(f"{STATE_FILE}.tmp", "w", encoding="utf-8") as handle:
        json.dump(
            {
                "magic": SETTINGS_MAGIC,
                "offset": offset,
                "minMl": min_ml,
                "maxMl": max_ml,
                "scaleFactor": SCALE_FACTOR,
            },
            handle,
            indent=2,
        )
    os.replace(f"{STATE_FILE}.tmp", STATE_FILE)
    settings_loaded = True
    event("SETTINGS_SAVED")


def enter_state(next_state):
    global state

    previous = state
    state = next_state
    event("STATE_CHANGE", **{"from": previous, "to": next_state})

    if state == "CAL_TARE":
        event("NEED_TARE")
    elif state == "CAL_MIN":
        event("NEED_MIN")
    elif state == "CAL_MAX":
        event("NEED_MAX")
    elif state == "NORMAL":
        event("CAL_DONE")


class HX711:
    def __init__(self):
        if gpiod is None:
            raise RuntimeError("python3-libgpiod is required")

        self.request = gpiod.request_lines(
            CHIP_NAME,
            consumer="waterbowl-hx711",
            config={
                DATA_GPIO: gpiod.LineSettings(direction=Direction.INPUT),
                CLOCK_GPIO: gpiod.LineSettings(
                    direction=Direction.OUTPUT,
                    output_value=Value.INACTIVE,
                ),
            },
        )

    def is_ready(self):
        return self.request.get_value(DATA_GPIO) == Value.INACTIVE

    def read_raw(self, timeout_seconds=1.0):
        deadline = time.monotonic() + timeout_seconds

        while not self.is_ready():
            if time.monotonic() > deadline:
                raise TimeoutError("HX711_NOT_READY")
            time.sleep(0.001)

        value = 0
        for _ in range(24):
            self.request.set_value(CLOCK_GPIO, Value.ACTIVE)
            value = (value << 1) | int(self.request.get_value(DATA_GPIO) == Value.ACTIVE)
            self.request.set_value(CLOCK_GPIO, Value.INACTIVE)

        # 25th pulse selects channel A, gain 128 for the next conversion.
        self.request.set_value(CLOCK_GPIO, Value.ACTIVE)
        self.request.set_value(CLOCK_GPIO, Value.INACTIVE)

        if value & 0x800000:
            value -= 0x1000000

        return value

    def read_average(self, samples):
        readings = []
        while len(readings) < samples:
            try:
                readings.append(self.read_raw())
            except TimeoutError:
                pass
        return round(sum(readings) / len(readings))


def tare_scale(hx711):
    global offset, water_grams, water_ml

    event("TARE_START")
    offset = hx711.read_average(30)
    water_grams = 0.0
    water_ml = 0
    event("TARE_DONE", offset=offset, scale_factor=f"{SCALE_FACTOR:.2f}")


def update_water_reading(hx711):
    global water_grams, water_ml

    raw = hx711.read_raw()
    diff = raw - offset
    grams = diff / SCALE_FACTOR

    if not math.isfinite(grams) or abs(grams) > 1000000:
        grams = 0.0

    water_grams = grams
    ml = round(grams)
    water_ml = 0 if ml < ZERO_NOISE_ML else ml


def handle_command(command, hx711):
    global min_ml, max_ml

    command = command.strip().upper()

    if not command:
        return

    emit(f"RXCMD,ms={millis()},command={command}")

    if command in ("TARE", "T"):
        event("PI_TARE")
        tare_scale(hx711)
        if state == "CAL_TARE":
            enter_state("CAL_MIN")
    elif command == "SET_MIN":
        event("PI_SET_MIN")
        min_ml = water_ml
        event("MIN_SET")
        enter_state("CAL_MAX")
    elif command == "SET_MAX":
        event("PI_SET_MAX")
        max_ml = water_ml
        if max_ml <= min_ml:
            event("MAX_REJECTED_NOT_GREATER_THAN_MIN")
            return
        event("MAX_SET")
        save_settings()
        enter_state("NORMAL")
    else:
        event("UNKNOWN_COMMAND")


def process_stdin(hx711):
    ready, _, _ = select.select([sys.stdin], [], [], 0)
    if not ready:
        return

    line = sys.stdin.readline()
    if line == "":
        return

    handle_command(line, hx711)


def main():
    hx711 = HX711()
    time.sleep(1)
    emit("EVT,ms=0,name=BOOT,state=CAL_TARE,water_ml=0,min_ml=0,max_ml=0,settings=0")
    emit("INFO,protocol=2,source=pi-hx711,commands=TARE|SET_MIN|SET_MAX")

    if load_settings():
        event("SETTINGS_LOADED")
        enter_state("NORMAL")
    else:
        event("CAL_REQUIRED")
        enter_state("CAL_TARE")

    last_read = 0.0

    while True:
        process_stdin(hx711)

        now = time.monotonic()
        if now - last_read >= READ_INTERVAL_SECONDS:
            last_read = now
            try:
                update_water_reading(hx711)
            except TimeoutError:
                event("HX711_NOT_READY")
                continue

            telemetry()

        time.sleep(0.01)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        emit(f"ERR,ms={millis()},name=HX711_READER_CRASH,message={exc}")
        raise
