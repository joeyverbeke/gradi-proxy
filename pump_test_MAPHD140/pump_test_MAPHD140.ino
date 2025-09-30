// MAP-HD-140 pump exerciser
// XIAO ESP32S3 + DRV8833 (motor only, valve disabled)
// Wiring:
//   D0 -> DRV8833 SLP
//   D1 -> DRV8833 AIN1 (PWM)
//   D2 -> DRV8833 AIN2 (tie LOW for fixed direction)
//   Pump powered from 3 V rail (MAP-HD-140 rated 2.0–3.2 V)
//
// Serial commands (newline terminated):
//   SET <duty 0-1023>        : hold pump at duty, keep driver awake
//   BURST <duty> <ms>        : run burst for ms then return to hold duty
//   RAMP <from> <to> <ms>    : ramp between duties over duration
//   STOP                     : set duty=0 and let driver sleep
//   WAKE                     : wake driver without changing duty
//   INFO                     : print current status
//
// Goal: audition MAP-HD-140 behaviour at different PWM duty levels and timings.

#include <Arduino.h>

// Pins
constexpr int PIN_SLP  = D0;
constexpr int PIN_AIN1 = D1;  // PWM
constexpr int PIN_AIN2 = D2;  // direction (kept LOW)

// LEDC parameters
constexpr uint32_t PWM_FREQ = 32000; // >20 kHz to push motor noise ultrasonic
constexpr uint8_t  PWM_RES  = 10;    // 10-bit (0-1023 duty)
constexpr int      PWM_MAX  = (1 << PWM_RES) - 1;

// State
int currentDuty = 0;          // current PWM duty actually applied
int holdDuty    = 0;          // baseline duty when idle (0 = off)
bool driverAwake = false;

// Ramp support
bool     rampActive = false;
int      rampFrom   = 0;
int      rampTo     = 0;
uint32_t rampStart  = 0;
uint32_t rampDurMs  = 0;

void applyDuty(int duty) {
  if (duty < 0) duty = 0;
  if (duty > PWM_MAX) duty = PWM_MAX;
  currentDuty = duty;
  ledcWrite(PIN_AIN1, duty);
}

void ensureDriverAwake() {
  if (!driverAwake) {
    digitalWrite(PIN_SLP, HIGH);
    delayMicroseconds(200); // wake-up time per DRV8833 datasheet (~100 µs typ)
    driverAwake = true;
  }
}

void allowDriverSleep() {
  if (driverAwake && currentDuty == 0 && !rampActive && holdDuty == 0) {
    digitalWrite(PIN_SLP, LOW);
    driverAwake = false;
  }
}

void startRamp(int fromDuty, int toDuty, uint32_t durationMs) {
  if (durationMs == 0 || fromDuty == toDuty) {
    rampActive = false;
    applyDuty(toDuty);
    return;
  }
  ensureDriverAwake();
  rampFrom  = constrain(fromDuty, 0, PWM_MAX);
  rampTo    = constrain(toDuty,   0, PWM_MAX);
  rampDurMs = durationMs;
  rampStart = millis();
  rampActive = true;
  applyDuty(rampFrom);
}

void serviceRamp() {
  if (!rampActive) return;
  uint32_t now = millis();
  uint32_t elapsed = now - rampStart;
  if (elapsed >= rampDurMs) {
    rampActive = false;
    applyDuty(rampTo);
    allowDriverSleep();
    return;
  }
  int duty = rampFrom + (int32_t)(rampTo - rampFrom) * (int32_t)elapsed / (int32_t)rampDurMs;
  applyDuty(duty);
}

void setHoldDuty(int duty) {
  holdDuty = constrain(duty, 0, PWM_MAX);
  if (holdDuty > 0) {
    ensureDriverAwake();
    rampActive = false;
    applyDuty(holdDuty);
  } else {
    rampActive = false;
    applyDuty(0);
    allowDriverSleep();
  }
}

void doBurst(int duty, uint32_t durationMs) {
  duty = constrain(duty, 0, PWM_MAX);
  ensureDriverAwake();
  rampActive = false;
  applyDuty(duty);
  delay(durationMs);
  if (holdDuty > 0) {
    applyDuty(holdDuty);
  } else {
    applyDuty(0);
    allowDriverSleep();
  }
}

void printStatus() {
  Serial.print("driver="); Serial.print(driverAwake ? "awake" : "sleep");
  Serial.print(" hold="); Serial.print(holdDuty);
  Serial.print(" current="); Serial.print(currentDuty);
  Serial.print(" ramp="); Serial.print(rampActive ? "y" : "n");
  Serial.println();
}

void handleCommand(const char* line) {
  if (strncmp(line, "SET", 3) == 0) {
    int duty;
    if (sscanf(line + 3, "%d", &duty) == 1) {
      setHoldDuty(duty);
      Serial.print("OK set hold duty "); Serial.println(holdDuty);
    } else {
      Serial.println("ERR usage: SET <duty>");
    }
  } else if (strncmp(line, "BURST", 5) == 0) {
    int duty;
    int duration;
    if (sscanf(line + 5, "%d %d", &duty, &duration) == 2 && duration > 0) {
      Serial.println("OK burst");
      doBurst(duty, (uint32_t)duration);
    } else {
      Serial.println("ERR usage: BURST <duty> <ms>");
    }
  } else if (strncmp(line, "RAMP", 4) == 0) {
    int fromDuty, toDuty, duration;
    if (sscanf(line + 4, "%d %d %d", &fromDuty, &toDuty, &duration) == 3 && duration >= 0) {
      Serial.println("OK ramp");
      startRamp(fromDuty, toDuty, (uint32_t)duration);
    } else {
      Serial.println("ERR usage: RAMP <from> <to> <ms>");
    }
  } else if (strcmp(line, "STOP") == 0) {
    holdDuty = 0;
    rampActive = false;
    applyDuty(0);
    allowDriverSleep();
    Serial.println("OK stop");
  } else if (strcmp(line, "WAKE") == 0) {
    ensureDriverAwake();
    Serial.println("OK wake");
  } else if (strcmp(line, "INFO") == 0) {
    printStatus();
  } else if (strlen(line) == 0) {
    // ignore empty
  } else {
    Serial.println("ERR unknown command");
  }
}

void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 1500) { delay(10); }

  pinMode(PIN_SLP, OUTPUT);
  pinMode(PIN_AIN1, OUTPUT);
  pinMode(PIN_AIN2, OUTPUT);
  digitalWrite(PIN_AIN2, LOW);
  digitalWrite(PIN_SLP, LOW); // start asleep
  driverAwake = false;

  if (!ledcAttach(PIN_AIN1, PWM_FREQ, PWM_RES)) {
    Serial.println("ERR ledcAttach");
  }
  applyDuty(0);

  Serial.println("MAP-HD-140 pump test ready");
  Serial.println("Commands: SET, BURST, RAMP, STOP, WAKE, INFO");
}

void loop() {
  static char buffer[64];
  static uint8_t len = 0;

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r' || c == '\n') {
      if (len > 0) {
        buffer[len] = '\0';
        handleCommand(buffer);
        len = 0;
      }
    } else if (len < sizeof(buffer) - 1) {
      buffer[len++] = c;
    }
  }

  serviceRamp();
  allowDriverSleep();
}
