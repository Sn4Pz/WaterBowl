#include "HX711.h"

#define HX_DT 4
#define HX_SCK 5
#define TARE_BUTTON_PIN 2

HX711 scale;

long OFFSET = 0;
float SCALE_FACTOR = 314.0;  // temporary value
const float REFERENCE_WEIGHT_GRAMS = 227.0;

void tareScale() {
  Serial.println();
  Serial.println("=== TARE ===");

  OFFSET = scale.read_average(30);

  Serial.print("OFFSET = ");
  Serial.println(OFFSET);

  Serial.println("Place the 227 g reference weight on the scale.");
  Serial.println("Then read the suggested SCALE_FACTOR.");
  Serial.println();
}

void setup() {
  Serial.begin(115200);

  pinMode(TARE_BUTTON_PIN, INPUT_PULLUP);

  scale.begin(HX_DT, HX_SCK);
  scale.set_gain(128);

  delay(1000);

  Serial.println("HX711 calibration using 227 g reference weight");
  Serial.println("Short D2 to GND to tare.");

  tareScale();
}

void loop() {
  if (digitalRead(TARE_BUTTON_PIN) == LOW) {
    tareScale();
    delay(1000);
  }

  if (scale.is_ready()) {
    long raw = scale.read_average(10);
    long diff = raw - OFFSET;

    float grams = diff / SCALE_FACTOR;
    float suggestedScaleFactor = diff / REFERENCE_WEIGHT_GRAMS;

    Serial.print("RAW: ");
    Serial.print(raw);

    Serial.print(" | DIFF: ");
    Serial.print(diff);

    Serial.print(" | grams current: ");
    Serial.print(grams, 1);

    Serial.print(" | suggested SCALE_FACTOR: ");
    Serial.println(suggestedScaleFactor, 2);
  } else {
    Serial.println("HX711 not ready");
  }

  delay(300);
}