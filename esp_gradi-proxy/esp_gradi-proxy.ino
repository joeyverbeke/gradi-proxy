// XIAO ESP32S3 + DRV8833 + VCNL4040 (Arduino-ESP32 v3.x, non-blocking)
// Wiring (matches Seeed pinout image):
//   D0 -> DRV8833 SLP
//   Pump: AIN1 <- D1 (PWM), AIN2 <- D2 (LOW)
//   Valve: BIN1 <- D8, BIN2 <- D9
//   I2C (VCNL4040): SDA <- D4 (GPIO5), SCL <- D5 (GPIO6)

#include <Wire.h>
#include <Adafruit_VCNL4040.h>

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
int duty_run     = 1000;     // pump strength (0..1023)
int duty_idle    = 0;       // 0 = fully off between puffs
int ramp_time_ms = 60;      // quiet spin up/down
int rest_min_ms  = 1000;    // min rest after puff
int rest_max_ms  = 4000;    // max rest after puff

// -------------------- Puff state machine
enum PuffState { REST, PRECHARGE, PUFF, RECOVER };
PuffState puffState = REST;
uint32_t  stateStart = 0;
uint32_t  restTarget = 0;

// Forward declarations
void enterState(PuffState s, uint32_t now);
void updateRamp(uint32_t now);

// -------------------- Non-blocking ramp
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

// -------------------- Valve helpers
inline void valveOn()  { digitalWrite(V_BIN1, HIGH); digitalWrite(V_BIN2, LOW); }
inline void valveOff() { digitalWrite(V_BIN1, LOW);  digitalWrite(V_BIN2, LOW); }

// -------------------- State transitions
void enterState(PuffState s, uint32_t now) {
  puffState  = s;
  stateStart = now;
  switch (puffState) {
    case REST:
      startRamp(duty_run, duty_idle, ramp_time_ms);
      valveOff();
      restTarget = now + (uint32_t)random(rest_min_ms, rest_max_ms);
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

// -------------------- Fast sensor print throttling
uint32_t lastPrint = 0;
const uint32_t printIntervalMs = 10;  // print every 10 ms

void setup() {
  Serial.begin(115200);
  unsigned long t0 = millis();
  while (!Serial && millis() - t0 < 1500) { delay(10); }

  // I2C on D4 (SDA=GPIO5) / D5 (SCL=GPIO6)
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);

  // VCNL4040 init + fast-ish prox config
  if (!vcnl4040.begin(VCNL4040_I2CADDR_DEFAULT, &Wire)) {
    Serial.println("VCNL4040 not found"); while (1) { delay(10); }
  }
  Serial.println("VCNL4040 OK");
  vcnl4040.setProximityIntegrationTime(VCNL4040_PROXIMITY_INTEGRATION_TIME_1T);
  vcnl4040.setProximityHighResolution(false);
  vcnl4040.setProximityLEDDutyCycle(VCNL4040_LED_DUTY_1_40);

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
}

void loop() {
  uint32_t now = millis();

  // --- Fast sensor read
  uint16_t prox = vcnl4040.getProximity();
  if (now - lastPrint >= printIntervalMs) {
    lastPrint = now;
    Serial.print("t=");   Serial.print(now);
    Serial.print(" ms | prox="); Serial.println(prox);
  }

  // --- Update pump ramp
  updateRamp(now);

  // --- Puff state machine
  switch (puffState) {
    case REST:
      if ((int32_t)(now - restTarget) >= 0) enterState(PRECHARGE, now);
      break;
    case PRECHARGE:
      if (now - stateStart >= (uint32_t)precharge_ms) enterState(PUFF, now);
      break;
    case PUFF:
      if (now - stateStart >= (uint32_t)puff_ms) enterState(RECOVER, now);
      break;
    case RECOVER:
      if (now - stateStart >= (uint32_t)guard_ms) enterState(REST, now);
      break;
  }
}
