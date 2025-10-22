// XIAO ESP32S3 + DRV8833 + VCNL4040 (Arduino-ESP32 v3.x, non-blocking)
// Integrates blink detection logic with pump + valve sequencing.
// Wiring (matches Seeed pinout image):
//   D0 -> DRV8833 SLP
//   Pump: AIN1 <- D1 (PWM), AIN2 <- D2 (LOW)
//   Valve: BIN1 <- D8, BIN2 <- D9
//   I2C (VCNL4040): SDA <- D4 (GPIO5), SCL <- D5 (GPIO6)

#include <Wire.h>
#include <Adafruit_VCNL4040.h>
#include <string.h>
#include <math.h>

Adafruit_VCNL4040 vcnl4040;

// -------------------- Pins
const int SLP_PIN = D0;
const int P_AIN1  = D1;   // PWM -> AIN1
const int P_AIN2  = D2;   // LOW -> AIN2
const int V_BIN1  = D8;   // -> BIN1
const int V_BIN2  = D9;   // -> BIN2
const int SDA_PIN = D4;   // GPIO5
const int SCL_PIN = D5;   // GPIO6

// -------------------- PWM (v3.x LEDC pin-scoped)
const uint32_t PUMP_PWM_FREQ = 25000;   // 25 kHz (inaudible)
const uint8_t  PUMP_PWM_RES  = 10;      // 10-bit (0..1023)
const int      DUTY_MAX      = (1 << PUMP_PWM_RES) - 1;

// -------------------- Tunables
int precharge_ms = 220;     // pump build-up
int puff_ms      = 50;      // valve open
int guard_ms     = 350;     // eyelid recovery
int duty_run     = 1000;    // pump strength (0..1023)
int duty_idle    = 0;       // 0 = fully off between puffs
int ramp_time_ms = 60;      // quiet spin up/down

// -------------------- Blink detection cadence
const uint32_t SAMPLE_INTERVAL_MS = 5;     // ~200 Hz sampling
const uint32_t STATUS_INTERVAL_MS = 1000;  // status once per second

// -------------------- Presence gating (VCNL4040 prox counts)
const uint16_t PRESENCE_ENTER = 10;        // prox >= enter -> presence
const uint16_t PRESENCE_EXIT  = 5;         // prox <= exit  -> idle
const uint16_t ENTER_HOLD_MS  = 40;
const uint16_t EXIT_HOLD_MS   = 300;

// -------------------- Auto-cal blink detection (rise or dip)
const float    Z_ENTER         = 2.0f;     // sigma units to enter
const float    Z_EXIT          = 1.0f;     // sigma units to release
const uint16_t MIN_CROSS_MS    = 20;
const uint16_t REFRACTORY_MS   = 250;
const float    MIN_SIGMA_FLOOR = 0.8f;

// -------------------- Rolling baseline (EWMA)
const float    TAU_SEC  = 1.0f;
const float    DT_SEC   = (float)SAMPLE_INTERVAL_MS / 1000.0f;
const float    ALPHA    = DT_SEC / TAU_SEC;

// -------------------- Confidence gating
const uint32_t WARMUP_MS      = 600;
const uint16_t MIN_SAMPLES    = 120;
const float    SLOPE_TAU_SEC  = 0.3f;
const float    ALPHA_SLOPE    = DT_SEC / SLOPE_TAU_SEC;
const float    SLOPE_MAX      = 0.20f;
const float    CONF_REQUIRED  = 0.70f;

// -------------------- VCNL4040 PS configuration for detection
const VCNL4040_ProximityIntegration PS_INT  = VCNL4040_PROXIMITY_INTEGRATION_TIME_1T;
const VCNL4040_LEDDutyCycle         PS_DUTY = VCNL4040_LED_DUTY_1_80;
const VCNL4040_LEDCurrent           PS_CUR  = VCNL4040_LED_CURRENT_50MA;

// -------------------- WINK PPM scheduling
const uint8_t  SEQ_FRAMES         = 16;
const uint8_t  FRAME_SLOTS        = 4;
const uint32_t SLOT_DURATION_MS   = 400;                               // 0.4 s slots
const uint32_t FRAME_DURATION_MS  = SLOT_DURATION_MS * FRAME_SLOTS;    // 1.6 s
const uint32_t SEQUENCE_LEAD_MS   = 200;                               // small delay before first precharge

struct SequenceEvent {
  uint8_t  slot;
  uint32_t prechargeAt;
  uint32_t puffAt;
  uint32_t recoverAt;
  uint32_t guardDoneAt;
};

SequenceEvent sequenceEvents[SEQ_FRAMES];
bool          sequenceActive  = false;
uint8_t       sequenceIndex   = 0;
uint32_t      sequenceStartMs = 0;

// -------------------- Puff state machine
enum PuffState { REST, PRECHARGE, PUFF, RECOVER };
PuffState puffState = REST;
uint32_t  stateStart = 0;

// -------------------- Blink detection state
enum PresenceState { IDLE, PRESENCE };
PresenceState presence = IDLE;

uint32_t lastSampleMs     = 0;
uint32_t lastStatusMs     = 0;
uint32_t holdTimerMs      = 0;
uint32_t refractoryUntilMs = 0;
uint32_t presenceEnterMs   = 0;

uint16_t proxSample = 0;
bool     proxValid  = false;
uint32_t blinkCount = 0;

bool  statsInit     = false;
float mean_ps       = 0.0f;
float m2_ps         = 0.0f;
float prev_mean_ps  = 0.0f;
float slopeAbsEwma  = 0.0f;
float conf          = 0.0f;
uint32_t sampleCount = 0;

int8_t   devPolarity   = 0;  // +1 rise, -1 drop, 0 none
bool     beyondZ       = false;
uint32_t crossStartMs  = 0;

// -------------------- Fast sensor print throttling
uint32_t lastPrint = 0;
const uint32_t printIntervalMs = 10;  // print every 10 ms

// Forward declarations
void enterState(PuffState s, uint32_t now);
void updateRamp(uint32_t now);
void handleSerialInput();
void processCommand(const char* cmd);
void startProgrammedSequence();
void cancelSequence();

void handlePresenceFSM(uint32_t now, uint16_t prox);
void handleBlinkDetection(uint32_t now, uint16_t prox);
void resetStatsAndConfidence(uint32_t now);
void updateStats(uint16_t sample);
float currentSigma(bool floored);
void updateConfidence(uint32_t now);
void emitStatus(uint32_t now);
void emitBlinkEvent(uint32_t now, uint16_t prox, float sigma, float zRise, float zDrop, int8_t polarity);

// -------------------- Utility helpers
static inline float clamp01(float x) {
  if (x < 0.0f) return 0.0f;
  if (x > 1.0f) return 1.0f;
  return x;
}

void resetStatsAndConfidence(uint32_t now) {
  statsInit = false;
  mean_ps = 0.0f;
  m2_ps = 0.0f;
  prev_mean_ps = 0.0f;
  slopeAbsEwma = 0.0f;
  conf = 0.0f;
  sampleCount = 0;
  devPolarity = 0;
  beyondZ = false;
  crossStartMs = 0;
  refractoryUntilMs = 0;
  presenceEnterMs = now;
}

void updateStats(uint16_t x) {
  if (!statsInit) {
    statsInit = true;
    mean_ps = (float)x;
    m2_ps = (float)x * (float)x;
    prev_mean_ps = mean_ps;
    return;
  }
  mean_ps += ALPHA * ((float)x - mean_ps);
  m2_ps   += ALPHA * ((float)x * (float)x - m2_ps);
  float step = fabsf(mean_ps - prev_mean_ps);
  slopeAbsEwma += ALPHA_SLOPE * (step - slopeAbsEwma);
  prev_mean_ps = mean_ps;
}

float currentSigma(bool floored) {
  float var = m2_ps - mean_ps * mean_ps;
  if (var < 0.0f) var = 0.0f;
  float sigma = sqrtf(var);
  if (floored && sigma < MIN_SIGMA_FLOOR) sigma = MIN_SIGMA_FLOOR;
  return sigma;
}

void updateConfidence(uint32_t now) {
  float t_conf = clamp01((float)(now - presenceEnterMs) / (float)WARMUP_MS);
  float s_conf = clamp01((float)sampleCount / (float)MIN_SAMPLES);
  float stab_conf = 1.0f - clamp01(slopeAbsEwma / SLOPE_MAX);
  conf = t_conf;
  if (s_conf < conf) conf = s_conf;
  if (stab_conf < conf) conf = stab_conf;
}

void handlePresenceFSM(uint32_t now, uint16_t prox) {
  switch (presence) {
    case IDLE:
      if (prox >= PRESENCE_ENTER) {
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
      if (prox <= PRESENCE_EXIT) {
        if (holdTimerMs == 0) holdTimerMs = now;
        if ((now - holdTimerMs) >= EXIT_HOLD_MS) {
          presence = IDLE;
          holdTimerMs = 0;
          resetStatsAndConfidence(now);
        }
      } else {
        holdTimerMs = 0;
      }
      break;
  }
}

void emitBlinkEvent(uint32_t now, uint16_t prox, float sigma, float zRise, float zDrop, int8_t polarity) {
  Serial.print("BLINK time_ms=");
  Serial.print(now);
  Serial.print(" | prox=");
  Serial.print(prox);
  Serial.print(" | mean=");
  Serial.print((int)mean_ps);
  Serial.print(" | sigma=");
  Serial.print((int)sigma);
  Serial.print(" | zRise=");
  Serial.print(zRise, 2);
  Serial.print(" | zDrop=");
  Serial.print(zDrop, 2);
  Serial.print(" | polarity=");
  Serial.print(polarity == +1 ? "rise" : "dip");
  Serial.print(" | confidence=");
  Serial.print(conf, 2);
  Serial.print(" | blinks=");
  Serial.println(blinkCount);
}

void handleBlinkDetection(uint32_t now, uint16_t prox) {
  updateStats(prox);
  sampleCount++;
  updateConfidence(now);

  if (conf < CONF_REQUIRED) return;

  float sigma = currentSigma(true);
  float dev   = (float)prox - mean_ps;
  float zRise = sigma > 0.0f ? (dev / sigma) : 0.0f;
  float zDrop = -zRise;

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
      if (curPol != devPolarity) {
        devPolarity = curPol;
        crossStartMs = now;
      }
      if ((now - crossStartMs) >= MIN_CROSS_MS) {
        blinkCount++;
        refractoryUntilMs = now + REFRACTORY_MS;
        beyondZ = false;
        emitBlinkEvent(now, prox, sigma, zRise, zDrop, devPolarity);
        devPolarity = 0;
        crossStartMs = 0;
      }
    }
  } else if (beyondZ) {
    bool release = (devPolarity == +1) ? exitRise : exitDrop;
    if (release) {
      beyondZ = false;
      devPolarity = 0;
      crossStartMs = 0;
    }
  }
}

void emitStatus(uint32_t now) {
  Serial.print("STATUS time_ms=");
  Serial.print(now);
  Serial.print(" | state=");
  Serial.print(presence == PRESENCE ? "PRESENCE" : "IDLE");
  if (proxValid) {
    Serial.print(" | prox=");
    Serial.print(proxSample);
  }
  Serial.print(" | confidence=");
  Serial.print(conf, 2);
  Serial.print(" | blinks=");
  Serial.print(blinkCount);
  if (presence == PRESENCE && statsInit) {
    float sigma = currentSigma(true);
    float dev   = proxValid ? ((float)proxSample - mean_ps) : 0.0f;
    float zRise = sigma > 0.0f ? (dev / sigma) : 0.0f;
    float zDrop = -zRise;
    Serial.print(" | mean=");
    Serial.print((int)mean_ps);
    Serial.print(" | sigma=");
    Serial.print((int)sigma);
    Serial.print(" | zRise=");
    Serial.print(zRise, 2);
    Serial.print(" | zDrop=");
    Serial.print(zDrop, 2);
  }
  Serial.println();
}

// -------------------- Pump helpers
bool     rampActive = false;
int      rampFrom = 0, rampTo = 0;
uint32_t rampStart = 0, rampDur = 0;

void pumpSetDuty(int duty) {
  if (duty < 0) duty = 0;
  if (duty > DUTY_MAX) duty = DUTY_MAX;
  ledcWrite(P_AIN1, duty); // v3.x: write duty by pin
}

void startRamp(int fromDuty, int toDuty, uint32_t durationMs) {
  rampFrom  = fromDuty;
  rampTo    = toDuty;
  rampDur   = durationMs;
  rampStart = millis();
  rampActive = (durationMs > 0 && fromDuty != toDuty);
  if (!rampActive) pumpSetDuty(toDuty);
}

void updateRamp(uint32_t now) {
  if (!rampActive) return;
  uint32_t elapsed = now - rampStart;
  if (elapsed >= rampDur) {
    pumpSetDuty(rampTo);
    rampActive = false;
  } else {
    int duty = rampFrom + (int)((int32_t)(rampTo - rampFrom) * (int32_t)elapsed / (int32_t)rampDur);
    pumpSetDuty(duty);
  }
}

void cancelSequence() {
  if (!sequenceActive) return;
  sequenceActive = false;
  sequenceIndex = 0;
  sequenceStartMs = 0;
  Serial.print("SEQ CANCEL time_ms=");
  Serial.println(millis());
  enterState(REST, millis());
}

void startProgrammedSequence() {
  if (sequenceActive) {
    Serial.println("SEQ BUSY");
    return;
  }

  uint32_t now = millis();
  sequenceStartMs = now + SEQUENCE_LEAD_MS;

  for (uint8_t i = 0; i < SEQ_FRAMES; i++) {
    uint8_t slot = (uint8_t)random(0, FRAME_SLOTS);
    uint32_t frameBase = sequenceStartMs + (uint32_t)i * FRAME_DURATION_MS;
    uint32_t puffAt = frameBase + (uint32_t)slot * SLOT_DURATION_MS;
    uint32_t prechargeAt = puffAt;
    if (puffAt >= (uint32_t)precharge_ms) {
      prechargeAt = puffAt - (uint32_t)precharge_ms;
    }
    if (prechargeAt < frameBase) {
      prechargeAt = frameBase;
    }
    uint32_t recoverAt = puffAt + (uint32_t)puff_ms;
    uint32_t guardDoneAt = recoverAt + (uint32_t)guard_ms;

    sequenceEvents[i].slot = slot;
    sequenceEvents[i].prechargeAt = prechargeAt;
    sequenceEvents[i].puffAt = puffAt;
    sequenceEvents[i].recoverAt = recoverAt;
    sequenceEvents[i].guardDoneAt = guardDoneAt;
  }

  sequenceIndex = 0;
  sequenceActive = true;
  enterState(REST, now);

  Serial.print("SEQ START time_ms=");
  Serial.print(sequenceStartMs);
  Serial.print(" | slots=");
  for (uint8_t i = 0; i < SEQ_FRAMES; i++) {
    Serial.print(sequenceEvents[i].slot);
    if (i + 1 < SEQ_FRAMES) Serial.print(',');
  }
  Serial.print(" | lead_ms=");
  Serial.println(SEQUENCE_LEAD_MS);
}

void processCommand(const char* cmd) {
  if (strcmp(cmd, "START") == 0) {
    startProgrammedSequence();
  } else if (strcmp(cmd, "STOP") == 0) {
    cancelSequence();
  }
}

void handleSerialInput() {
  static char buffer[32];
  static uint8_t len = 0;

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (len > 0) {
        buffer[len] = '\0';
        processCommand(buffer);
        len = 0;
      }
    } else if (len < sizeof(buffer) - 1) {
      buffer[len++] = c;
    }
  }
}

inline void valveOn()  { digitalWrite(V_BIN1, HIGH); digitalWrite(V_BIN2, LOW); }
inline void valveOff() { digitalWrite(V_BIN1, LOW);  digitalWrite(V_BIN2, LOW); }

void enterState(PuffState s, uint32_t now) {
  puffState  = s;
  stateStart = now;
  switch (puffState) {
    case REST:
      startRamp(duty_run, duty_idle, ramp_time_ms);
      valveOff();
      break;
    case PRECHARGE:
      startRamp(duty_idle, duty_run, ramp_time_ms);
      break;
    case PUFF:
      valveOn();
      break;
    case RECOVER:
      startRamp(duty_run, duty_idle, ramp_time_ms);
      valveOff();
      break;
  }
}

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 1500) { delay(10); }

  // I2C on D4 (SDA=GPIO5) / D5 (SCL=GPIO6)
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);

  // VCNL4040 init + blink detection config
  if (!vcnl4040.begin(VCNL4040_I2CADDR_DEFAULT, &Wire)) {
    Serial.println("VCNL4040 not found"); while (1) { delay(10); }
  }
  Serial.println("VCNL4040 OK");
  vcnl4040.setProximityIntegrationTime(PS_INT);
  vcnl4040.setProximityHighResolution(false);
  vcnl4040.setProximityLEDDutyCycle(PS_DUTY);
  vcnl4040.setProximityLEDCurrent(PS_CUR);
  for (int i = 0; i < 5; i++) { (void)vcnl4040.getProximity(); delay(5); }

  // Pins
  pinMode(SLP_PIN, OUTPUT);
  pinMode(P_AIN1, OUTPUT);
  pinMode(P_AIN2, OUTPUT);
  pinMode(V_BIN1, OUTPUT);
  pinMode(V_BIN2, OUTPUT);

  digitalWrite(P_AIN2, LOW); // pump dir fixed
  valveOff();

  // PWM attach (v3.x API)
  if (!ledcAttach(P_AIN1, PUMP_PWM_FREQ, PUMP_PWM_RES)) {
    Serial.println("ledcAttach failed");
  }
  pumpSetDuty(0);

  digitalWrite(SLP_PIN, HIGH); // wake driver
  delay(2);

  randomSeed(esp_random());

  // Start state machine in REST
  enterState(REST, millis());

  // Prime detection state
  resetStatsAndConfidence(millis());
}

void loop() {
  handleSerialInput();
  uint32_t now = millis();

  // --- Blink detection sampling (non-blocking)
  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    uint16_t prox = vcnl4040.getProximity();
    proxSample = prox;
    proxValid = true;

    handlePresenceFSM(now, prox);
    if (presence == PRESENCE) {
      handleBlinkDetection(now, prox);
    }
  }

  // --- Periodic status report
  if (now - lastStatusMs >= STATUS_INTERVAL_MS) {
    lastStatusMs = now;
    emitStatus(now);
  }

  // --- Raw proximity stream (legacy format for host UI)
  if (proxValid && (now - lastPrint) >= printIntervalMs) {
    lastPrint = now;
    Serial.print("t=");   Serial.print(now);
    Serial.print(" ms | prox="); Serial.println(proxSample);
  }

  // --- Update pump ramp
  updateRamp(now);

  // --- Puff state machine
  SequenceEvent* current = (sequenceActive && sequenceIndex < SEQ_FRAMES) ? &sequenceEvents[sequenceIndex] : nullptr;

  switch (puffState) {
    case REST:
      if (current && (int32_t)(now - current->prechargeAt) >= 0) {
        enterState(PRECHARGE, now);
      }
      break;
    case PRECHARGE:
      if (!current) {
        enterState(REST, now);
      } else if ((int32_t)(now - current->puffAt) >= 0) {
        enterState(PUFF, now);
      }
      break;
    case PUFF:
      if (!current) {
        enterState(REST, now);
      } else if ((int32_t)(now - current->recoverAt) >= 0) {
        enterState(RECOVER, now);
      }
      break;
    case RECOVER:
      if (!current) {
        enterState(REST, now);
      } else if ((int32_t)(now - current->guardDoneAt) >= 0) {
        sequenceIndex++;
        if (sequenceIndex >= SEQ_FRAMES) {
          sequenceActive = false;
          sequenceStartMs = 0;
          sequenceIndex = 0;
          Serial.print("SEQ END time_ms=");
          Serial.println(now);
          current = nullptr;
        } else {
          current = &sequenceEvents[sequenceIndex];
        }
        enterState(REST, now);
      }
      break;
  }
}
