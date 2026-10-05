// PulmoSense firmware: ESP32 + MQ-3 / MQ-135 / MQ-7 -> local WebSocket server + Serial. No cloud.
// Wiring (demo): each MQ AO -> 10k series resistor -> GPIO, no divider. Button: GPIO25 to GND.
// Inputs clip near 3.1 V. The safe wiring is a 10k + 10k divider (AO -> 10k -> node -> GPIO,
// node -> 10k -> GND); if you use it, set DIVIDER to 2.0f below.
// Library needed: "WebSockets" by Markus Sattler (Library Manager).
//
// The website connects to  ws://<device-ip>:81   (AP mode IP is 192.168.4.1)
// Messages are JSON text:
//   {"type":"hello","state":"ready","hasBaseline":true}
//   {"type":"live","ms":123456,"mq3":0.812,"mq135":1.020,"mq7":0.655,"state":"ready","warmupLeft":0}
//   {"type":"baseline","mq3":..,"mq135":..,"mq7":..}
//   {"type":"capture","n":1,"mq3":..,"mq135":..,"mq7":..,"ratioMq3":..,"ratioMq135":..,"ratioMq7":..}
// "ms" is the device uptime in ms; the website should timestamp messages with its own clock.
// The website may send one command:
//   {"cmd":"capture"}   same as pressing the button (ignored unless state is ready)

#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebSocketsServer.h>

// ---------- Network ----------
const bool USE_OWN_NETWORK = true;          // true: ESP32 makes its own WiFi. false: join WIFI_SSID below
const char* AP_SSID  = "PulmoSense";        // own-network name
const char* AP_PASS  = "pulmosense1";       // at least 8 characters
const char* WIFI_SSID     = "YOUR_WIFI";    // only used when USE_OWN_NETWORK is false. 2.4 GHz only
const char* WIFI_PASSWORD = "YOUR_PASSWORD"; // if joining fails, it falls back to its own network
const char* HOST_NAME = "pulmosense";       // reachable as pulmosense.local on most laptops

// ---------- Pins (ADC1 only, so they keep working with WiFi on) ----------
const int PIN_MQ3   = 34;
const int PIN_MQ135 = 32;
const int PIN_MQ7   = 35;
const int PIN_BTN   = 25;

const int   PINS[3]  = {PIN_MQ3, PIN_MQ135, PIN_MQ7};
const char* NAMES[3] = {"MQ3", "MQ135", "MQ7"};

// ---------- Settings ----------
const float DIVIDER = 1.0f;                        // 1.0 = no divider. Use 2.0f with a 10k + 10k divider
const int   SAMPLES = 32;                          // ADC samples averaged per reading

const uint32_t WARMUP_MS   = 10UL * 1000UL;        // demo value. Real use: 5 min, readings are unstable at 10 s
const uint32_t BASELINE_MS = 10000;                // clean-air baseline window
const uint32_t CAPTURE_MS  = 5000;                 // capture window after button press
const uint32_t SAMPLE_MS   = 100;                  // sensor sampling interval
const uint32_t LIVE_MS     = 500;                  // live push interval
const uint32_t DEBOUNCE_MS = 30;

// ---------- State ----------
enum State { WARMUP, BASELINE, READY, CAPTURING };
const char* STATE_NAMES[] = {"warmup", "baseline", "ready", "capturing"};
State    state = WARMUP;
uint32_t stateStart = 0;

WebSocketsServer ws(81);

float  latest[3]   = {0, 0, 0};
float  baseline[3] = {0, 0, 0};
bool   hasBaseline = false;
double acc[3]      = {0, 0, 0};
int    accN        = 0;
int    captureCount = 0;

void setState(State s);

// ---------- Sensors ----------
float readSensorV(int pin) {
  uint32_t sum = 0;
  for (int i = 0; i < SAMPLES; i++) {
    sum += analogReadMilliVolts(pin);
    delayMicroseconds(200);
  }
  return (sum / (float)SAMPLES) / 1000.0f * DIVIDER;
}

void readAll(float out[3]) {
  for (int i = 0; i < 3; i++) out[i] = readSensorV(PINS[i]);
}

void resetAcc() {
  for (int i = 0; i < 3; i++) acc[i] = 0;
  accN = 0;
}

// ---------- Button (debounced, true once per press) ----------
bool buttonPressed() {
  static bool lastRead = HIGH, stable = HIGH;
  static uint32_t changedAt = 0;
  bool r = digitalRead(PIN_BTN);
  if (r != lastRead) {
    lastRead = r;
    changedAt = millis();
  }
  if (millis() - changedAt > DEBOUNCE_MS && r != stable) {
    stable = r;
    if (stable == LOW) return true;
  }
  return false;
}

// ---------- Messages ----------
void sendHello(uint8_t num) {
  char buf[120];
  snprintf(buf, sizeof(buf), "{\"type\":\"hello\",\"state\":\"%s\",\"hasBaseline\":%s}",
           STATE_NAMES[state], hasBaseline ? "true" : "false");
  ws.sendTXT(num, buf);
  if (hasBaseline) {
    snprintf(buf, sizeof(buf), "{\"type\":\"baseline\",\"mq3\":%.3f,\"mq135\":%.3f,\"mq7\":%.3f}",
             baseline[0], baseline[1], baseline[2]);
    ws.sendTXT(num, buf);
  }
}

void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_CONNECTED) {
    sendHello(num);
  } else if (type == WStype_TEXT) {
    // Only command: {"cmd":"capture"}. Same as the physical button, so it only acts when ready.
    // The library null-terminates text payloads, so strstr is safe here.
    if (strstr((const char*)payload, "\"capture\"") && state == READY) {
      Serial.println("Capture requested from the website.");
      setState(CAPTURING);
    }
  }
}

void sendLive(uint32_t now) {
  Serial.printf("LIVE,%.3f,%.3f,%.3f\n", latest[0], latest[1], latest[2]);
  if (!ws.connectedClients()) return;

  int warmLeft = 0;
  if (state == WARMUP && now - stateStart < WARMUP_MS) warmLeft = (WARMUP_MS - (now - stateStart)) / 1000;

  char buf[200];
  snprintf(buf, sizeof(buf),
           "{\"type\":\"live\",\"ms\":%lu,\"mq3\":%.3f,\"mq135\":%.3f,\"mq7\":%.3f,\"state\":\"%s\",\"warmupLeft\":%d}",
           (unsigned long)now, latest[0], latest[1], latest[2], STATE_NAMES[state], warmLeft);
  ws.broadcastTXT(buf);
}

// ---------- State machine ----------
void setState(State s) {
  state = s;
  stateStart = millis();
  if (s == BASELINE) {
    Serial.println("Keep sensors in clean air. Taking baseline...");
    resetAcc();
  } else if (s == CAPTURING) {
    Serial.println("Capturing...");
    resetAcc();
  } else if (s == READY) {
    Serial.println("Ready. Press the button (or Start capture on the website), then breathe toward the sensors.");
  }
}

void finishBaseline() {
  for (int i = 0; i < 3; i++) baseline[i] = accN ? (float)(acc[i] / accN) : latest[i];
  hasBaseline = true;
  Serial.printf("BASELINE_V,%.3f,%.3f,%.3f\n", baseline[0], baseline[1], baseline[2]);

  char buf[120];
  snprintf(buf, sizeof(buf), "{\"type\":\"baseline\",\"mq3\":%.3f,\"mq135\":%.3f,\"mq7\":%.3f}",
           baseline[0], baseline[1], baseline[2]);
  ws.broadcastTXT(buf);
}

void finishCapture() {
  float avg[3], ratio[3];
  for (int i = 0; i < 3; i++) {
    avg[i]   = accN ? (float)(acc[i] / accN) : latest[i];
    ratio[i] = (baseline[i] > 0.01f) ? avg[i] / baseline[i] : 0;
  }
  captureCount++;
  Serial.println("SAMPLE,sensor,volts,ratio_vs_baseline");
  for (int i = 0; i < 3; i++) Serial.printf("SAMPLE,%s,%.3f,%.2f\n", NAMES[i], avg[i], ratio[i]);

  char buf[260];
  snprintf(buf, sizeof(buf),
           "{\"type\":\"capture\",\"n\":%d,\"mq3\":%.3f,\"mq135\":%.3f,\"mq7\":%.3f,"
           "\"ratioMq3\":%.2f,\"ratioMq135\":%.2f,\"ratioMq7\":%.2f}",
           captureCount, avg[0], avg[1], avg[2], ratio[0], ratio[1], ratio[2]);
  ws.broadcastTXT(buf);
}

// ---------- Network ----------
void startOwnNetwork() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);
  Serial.printf("Own network \"%s\" up. Device IP %s\n", AP_SSID, WiFi.softAPIP().toString().c_str());
}

void startNetwork() {
  if (USE_OWN_NETWORK) {
    startOwnNetwork();
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    Serial.print(".");
    delay(300);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nJoined WiFi. Device IP %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nCould not join WiFi. Falling back to own network.");
    startOwnNetwork();
  }
}

// ---------- Setup ----------
void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(PIN_BTN, INPUT_PULLUP);
  for (int i = 0; i < 3; i++) analogSetPinAttenuation(PINS[i], ADC_11db);

  Serial.println("\nPulmoSense start");
  startNetwork();
  if (MDNS.begin(HOST_NAME)) Serial.printf("Also reachable as %s.local\n", HOST_NAME);

  ws.begin();
  ws.onEvent(onWsEvent);
  Serial.println("WebSocket server on port 81");

  readAll(latest);
  setState(WARMUP);
}

// ---------- Loop ----------
void loop() {
  static uint32_t lastSample = 0, lastLive = 0, lastWarmPrint = 0;
  ws.loop();

  uint32_t now = millis();
  bool pressed = buttonPressed();

  if (now - lastSample >= SAMPLE_MS) {
    lastSample = now;
    readAll(latest);
    if (state == BASELINE || state == CAPTURING) {
      for (int i = 0; i < 3; i++) acc[i] += latest[i];
      accN++;
    }
  }

  if (state == WARMUP) {
    if (now - lastWarmPrint >= 10000) {
      lastWarmPrint = now;
      unsigned long left = (now - stateStart < WARMUP_MS) ? (WARMUP_MS - (now - stateStart)) / 1000 : 0;
      Serial.printf("Warming up, %lu s left\n", left);
    }
    if (now - stateStart >= WARMUP_MS) setState(BASELINE);
  } else if (state == BASELINE) {
    if (now - stateStart >= BASELINE_MS) {
      finishBaseline();
      setState(READY);
    }
  } else if (state == CAPTURING) {
    if (now - stateStart >= CAPTURE_MS) {
      finishCapture();
      setState(READY);
    }
  } else if (state == READY && pressed) {
    setState(CAPTURING);
  }

  if (now - lastLive >= LIVE_MS) {
    lastLive = now;
    sendLive(now);
  }
}
