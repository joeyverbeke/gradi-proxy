// VCNL4040 Auto-Cal Blink Detector v3 (XIAO ESP32S3)
// Adds confidence gating to suppress early false positives
// Wiring: SDA=D4 (GPIO5), SCL=D5 (GPIO6) | Serial: 115200

#include <Wire.h>
#include <Adafruit_VCNL4040.h>

Adafruit_VCNL4040 vcnl;

// I2C pins (XIAO ESP32S3)
const int SDA_PIN = D4; // GPIO5
const int SCL_PIN = D5; // GPIO6

// Cadence
const uint32_t SAMPLE_INTERVAL_MS = 5;     // ~200 Hz sampling
const uint32_t STATUS_INTERVAL_MS = 1000;  // status once per second

// Presence gating
const uint16_t PRESENCE_ENTER = 10;        // prox >= enter -> presence
const uint16_t PRESENCE_EXIT  = 5;         // prox <= exit  -> idle
const uint16_t ENTER_HOLD_MS  = 40;
const uint16_t EXIT_HOLD_MS   = 300;

// Auto-cal blink detection (rise or dip)
const float    Z_ENTER        = 2.0f;      // sigma units to enter
const float    Z_EXIT         = 1.0f;      // sigma units to release
const uint16_t MIN_CROSS_MS   = 20;
const uint16_t REFRACTORY_MS  = 250;
const float    MIN_SIGMA_FLOOR = 0.8f;

// Rolling baseline (EWMA)
const float    TAU_SEC        = 1.0f;
const float    DT_SEC         = (float)SAMPLE_INTERVAL_MS / 1000.0f;
const float    ALPHA          = DT_SEC / TAU_SEC;

// Confidence gating
const uint32_t WARMUP_MS      = 600;       // time component
const uint16_t MIN_SAMPLES    = 120;       // ~0.6 s at 5 ms
const float    SLOPE_TAU_SEC  = 0.3f;      // stability component
const float    ALPHA_SLOPE    = DT_SEC / SLOPE_TAU_SEC;
const float    SLOPE_MAX      = 0.20f;     // counts/sample allowed drift
const float    CONF_REQUIRED  = 0.70f;     // gate for events

// VCNL4040 PS configuration
const VCNL4040_ProximityIntegration PS_INT  = VCNL4040_PROXIMITY_INTEGRATION_TIME_1T;
const VCNL4040_LEDDutyCycle         PS_DUTY = VCNL4040_LED_DUTY_1_80;
const VCNL4040_LEDCurrent           PS_CUR  = VCNL4040_LED_CURRENT_50MA;

// State
enum PresenceState { IDLE, PRESENCE };
PresenceState presence = IDLE;

// Timing
uint32_t lastSampleMs = 0;
uint32_t lastStatusMs = 0;
uint32_t holdTimerMs  = 0;

// Data
uint16_t prox = 0;
uint32_t blinkCount = 0;

// Stats
bool     statsInit = false;
float    mean_ps = 0.0f;   // E[x]
float    m2_ps   = 0.0f;   // E[x^2]

// Blink internals
int8_t   devPolarity = 0;  // +1 rise, -1 drop, 0 none
bool     beyondZ = false;
uint32_t crossStartMs = 0;
uint32_t refractoryUntilMs = 0;

// Confidence internals
uint32_t presenceEnterMs = 0;
uint32_t sampleCount = 0;
float    prev_mean_ps = 0.0f;
float    slopeAbsEwma = 0.0f;
float    conf = 0.0f;

static inline float clamp01(float x){ return x < 0 ? 0 : (x > 1 ? 1 : x); }

void resetStatsAndConfidence(uint32_t now) {
  statsInit = false;
  mean_ps = 0.0f;
  m2_ps   = 0.0f;
  devPolarity = 0;
  beyondZ = false;
  crossStartMs = 0;
  sampleCount = 0;
  prev_mean_ps = 0.0f;
  slopeAbsEwma = 0.0f;
  conf = 0.0f;
  presenceEnterMs = now;
}

void updateStats(uint16_t x) {
  if (!statsInit) {
    statsInit = true;
    mean_ps = (float)x;
    m2_ps   = (float)x * (float)x;
    prev_mean_ps = mean_ps;
    return;
  }
  // EWMA mean/second moment
  mean_ps += ALPHA * ((float)x - mean_ps);
  m2_ps   += ALPHA * ((float)x * (float)x - m2_ps);

  // Stability: EWMA of absolute mean step per sample
  float step = fabsf(mean_ps - prev_mean_ps);
  slopeAbsEwma += ALPHA_SLOPE * (step - slopeAbsEwma);
  prev_mean_ps = mean_ps;
}

float currentSigma(bool floored=true) {
  float var = m2_ps - mean_ps * mean_ps;
  if (var < 0.0f) var = 0.0f;
  float sigma = sqrtf(var);
  if (floored && sigma < MIN_SIGMA_FLOOR) sigma = MIN_SIGMA_FLOOR;
  return sigma;
}

void updateConfidence(uint32_t now) {
  // Components
  float t_conf = clamp01((float)(now - presenceEnterMs) / (float)WARMUP_MS);
  float s_conf = clamp01((float)sampleCount / (float)MIN_SAMPLES);
  float stab_conf = 1.0f - clamp01(slopeAbsEwma / SLOPE_MAX);
  // Combine conservatively
  conf = t_conf;
  if (s_conf < conf) conf = s_conf;
  if (stab_conf < conf) conf = stab_conf;
}

void setupSensor() {
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);
  if (!vcnl.begin(VCNL4040_I2CADDR_DEFAULT, &Wire)) {
    Serial.println(F("VCNL4040 not found")); while (1) { delay(10); }
  }
  vcnl.setProximityIntegrationTime(PS_INT);
  vcnl.setProximityLEDDutyCycle(PS_DUTY);
  vcnl.setProximityLEDCurrent(PS_CUR);
  vcnl.setProximityHighResolution(false);
  for (int i = 0; i < 5; i++) { (void)vcnl.getProximity(); delay(5); }
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 1500) { delay(10); }
  Serial.println(F("VCNL4040 Auto-Cal Blink Detector v3 (confidence gating)"));
  setupSensor();
}

void handlePresenceFSM(uint32_t now, uint16_t x) {
  switch (presence) {
    case IDLE:
      if (x >= PRESENCE_ENTER) {
        if (holdTimerMs == 0) holdTimerMs = now;
        if ((now - holdTimerMs) >= ENTER_HOLD_MS) {
          presence = PRESENCE;
          holdTimerMs = 0;
          resetStatsAndConfidence(now);
        }
      } else {
        holdTimerMs = 0;
      }
      break;
    case PRESENCE:
      if (x <= PRESENCE_EXIT) {
        if (holdTimerMs == 0) holdTimerMs = now;
        if ((now - holdTimerMs) >= EXIT_HOLD_MS) {
          presence = IDLE;
          holdTimerMs = 0;
          // Reset when leaving presence so next wearer starts fresh
          resetStatsAndConfidence(now);
        }
      } else {
        holdTimerMs = 0;
      }
      break;
  }
}

void handleBlinkDetection(uint32_t now, uint16_t x) {
  // Update rolling stats and confidence inputs
  updateStats(x);
  sampleCount++;
  updateConfidence(now);

  // Gate on confidence
  if (conf < CONF_REQUIRED) return;

  float sigma = currentSigma(true);
  float dev   = (float)x - mean_ps; // +rise, -dip
  float zRise = dev / sigma;
  float zDrop = -dev / sigma;

  // Refractory
  if ((int32_t)(now - refractoryUntilMs) < 0) {
    beyondZ = false;
    devPolarity = 0;
    crossStartMs = 0;
    return;
  }

  bool enterRise = (zRise >= Z_ENTER);
  bool enterDrop = (zDrop >= Z_ENTER);
  bool enterAny  = enterRise || enterDrop;

  bool exitRise = (zRise <= Z_EXIT);
  bool exitDrop = (zDrop <= Z_EXIT);

  if (enterAny) {
    int8_t curPol = enterRise ? +1 : -1;
    if (!beyondZ) {
      beyondZ = true;
      devPolarity = curPol;
      crossStartMs = now;
    } else {
      if (curPol != devPolarity) { // polarity flip restarts dwell
        devPolarity = curPol;
        crossStartMs = now;
      }
      if ((now - crossStartMs) >= MIN_CROSS_MS) {
        // Blink event
        blinkCount++;
        refractoryUntilMs = now + REFRACTORY_MS;
        beyondZ = false;

        Serial.print(F("event t=")); Serial.print(now);
        Serial.print(F(" ms | prox=")); Serial.print(x);
        Serial.print(F(" | mean=")); Serial.print((int)mean_ps);
        Serial.print(F(" | sigma=")); Serial.print((int)currentSigma(true));
        Serial.print(F(" | zRise=")); Serial.print(zRise, 2);
        Serial.print(F(" | zDrop=")); Serial.print(zDrop, 2);
        Serial.print(F(" | polarity=")); Serial.print(devPolarity == +1 ? F("rise") : F("drop"));
        Serial.print(F(" | conf=")); Serial.print(conf, 2);
        Serial.print(F(" | blink_event=1 | blinks=")); Serial.println(blinkCount);

        devPolarity = 0;
        crossStartMs = 0;
      }
    }
  } else {
    if (beyondZ) {
      bool release = (devPolarity == +1) ? exitRise : exitDrop;
      if (release) {
        beyondZ = false;
        devPolarity = 0;
        crossStartMs = 0;
      }
    }
  }
}

void loop() {
  uint32_t now = millis();

  // Fixed-rate sampling
  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    prox = vcnl.getProximity();

    // Presence gate
    handlePresenceFSM(now, prox);

    // In PRESENCE, auto-cal + blink detection with confidence
    if (presence == PRESENCE) {
      handleBlinkDetection(now, prox);
    }
  }

  // Status
  if (now - lastStatusMs >= STATUS_INTERVAL_MS) {
    lastStatusMs = now;
    Serial.print(F("status t=")); Serial.print(now);
    Serial.print(F(" ms | state=")); Serial.print(presence == IDLE ? F("IDLE") : F("PRESENCE"));
    Serial.print(F(" | prox=")); Serial.print(prox);
    if (presence == PRESENCE && statsInit) {
      float sigma = currentSigma(true);
      float dev   = (float)prox - mean_ps;
      float zRise = dev / sigma;
      float zDrop = -dev / sigma;
      Serial.print(F(" | mean=")); Serial.print((int)mean_ps);
      Serial.print(F(" | sigma=")); Serial.print((int)sigma);
      Serial.print(F(" | zRise=")); Serial.print(zRise, 2);
      Serial.print(F(" | zDrop=")); Serial.print(zDrop, 2);
      Serial.print(F(" | conf=")); Serial.print(conf, 2);
    } else {
      Serial.print(F(" | conf=")); Serial.print(conf, 2);
    }
    Serial.print(F(" | blinks=")); Serial.println(blinkCount);
  }
}