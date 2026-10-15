// PulmoSense firmware: ESP32 + MQ-3 / MQ-135 / MQ-7 -> local WebSocket server + Serial + OLED + LED.
// Wiring: each MQ AO -> 10k -> node -> GPIO, node -> 10k -> GND (10k + 10k divider). Button: GPIO4 to GND.
// With the divider, DIVIDER must be 2.0f. If you wire a single series resistor instead, set it to 1.0f.
// LED: anode -> 220R -> GPIO26, cathode to GND. OLED (SSD1306 128x64, 0x3C): SDA 21, SCL 22, VCC 3V3, GND.
// Libraries (Library Manager): "WebSockets" by Markus Sattler, "Adafruit SSD1306", "Adafruit GFX Library".
//
// Boot: intro animation -> network -> waits for the dashboard to connect (press the button to skip).
// Button: press = start a capture (only when READY). Hold 3 s = restart warm-up.
//
// The website connects to  ws://<device-ip>:81   (AP mode IP is 192.168.4.1)
// Messages from the device are JSON text:
//   {"type":"hello","state":"ready","hasBaseline":true}
//   {"type":"live","ms":123456,"mq3":0.812,"mq135":1.020,"mq7":0.655,"state":"ready","warmupLeft":0}
//   {"type":"baseline","mq3":..,"mq135":..,"mq7":..}
//   {"type":"capture","n":1,"mq3":..,"mq135":..,"mq7":..,"ratioMq3":..,"ratioMq135":..,"ratioMq7":..}
//   {"type":"restart"}      warm-up was restarted (long press or website); the old baseline is discarded
// "ms" is the device uptime in ms; the website should timestamp messages with its own clock.
// Commands the website may send:
//   {"cmd":"capture"}   same as a button press (ignored unless state is ready)
//   {"cmd":"restart"}   same as holding the button for 3 s (restarts warm-up, discards the baseline)

#include <Arduino.h>
#include <string.h>
#include <Wire.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebSocketsServer.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ---------- Network ----------
const bool USE_OWN_NETWORK = false;          // true: ESP32 makes its own WiFi. false: join WIFI_SSID below
const char* AP_SSID  = "PulmoSense";        // own-network name
const char* AP_PASS  = "pulmosense1";       // at least 8 characters
const char* WIFI_SSID     = "YOUR_WIFI";    // only used when USE_OWN_NETWORK is false. 2.4 GHz only
const char* WIFI_PASSWORD = "YOUR_PASSWORD"; // if joining fails, it falls back to its own network
const char* HOST_NAME = "pulmosense";       // reachable as pulmosense.local on most laptops

// ---------- Pins (sensors on ADC1 only, so they keep working with WiFi on) ----------
const int PIN_MQ3   = 34;
const int PIN_MQ135 = 32;
const int PIN_MQ7   = 35;
const int PIN_BTN   = 4;
const int PIN_LED   = 26;
const int PIN_SDA   = 21;
const int PIN_SCL   = 22;
const uint8_t OLED_ADDR = 0x3C;

const int   PINS[3]  = {PIN_MQ3, PIN_MQ135, PIN_MQ7};
const char* NAMES[3] = {"MQ3", "MQ135", "MQ7"};

// ---------- Settings ----------
const float DIVIDER = 2.0f;                        // 2.0f with a 10k + 10k divider, 1.0f with no divider
const int   SAMPLES = 32;                          // ADC samples averaged per reading

const uint32_t WARMUP_MS   = 10UL * 1000UL;        // demo value. Real use: 5 min, readings are unstable at 10 s
const uint32_t BASELINE_MS = 10000;                // clean-air baseline window
const uint32_t CAPTURE_MS  = 30000;                // capture window after button press
const uint32_t SAMPLE_MS   = 100;                  // sensor sampling interval
const uint32_t LIVE_MS     = 500;                  // live push interval
const uint32_t DEBOUNCE_MS = 30;
const uint32_t HOLD_HINT_MS  = 1000;               // show the "hold to restart" bar after this long
const uint32_t LONG_PRESS_MS = 3000;               // hold this long to restart warm-up
const uint32_t DONE_UI_MS  = 10000;                // how long the result screen stays after a capture
const uint32_t FRAME_MS    = 100;                  // OLED refresh interval
const float    RATIO_HIGH  = 1.1f;                 // same cut-off as the dashboard (src/config.ts)

// ---------- Types and state (types must come before any function) ----------
enum State { WARMUP, BASELINE, READY, CAPTURING };
enum BtnEvent { BTN_NONE, BTN_PRESS, BTN_LONG };
const char* STATE_NAMES[] = {"warmup", "baseline", "ready", "capturing"};
State    state = WARMUP;
uint32_t stateStart = 0;

WebSocketsServer ws(81);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
bool oledOk = false;

float  latest[3]    = {0, 0, 0};
float  baseline[3]  = {0, 0, 0};
bool   lastMild     = false;                       // last capture: any ratio above RATIO_HIGH
bool   hasBaseline  = false;
double acc[3]       = {0, 0, 0};
int    accN         = 0;
int    captureCount = 0;
uint32_t uiDoneStart = 0;                          // OLED/LED result display only; not part of the protocol
uint32_t toastUntil  = 0;                          // "not ready" message on the OLED
bool     btnDown     = false;                      // debounced: true while the button is held
uint32_t btnDownAt   = 0;
bool     bootPhase   = true;                       // true until the boot sequence has finished
String   netName, netIp;                           // shown on the "waiting" screen

void setState(State s);
void restartWarmup();

bool showingDone(uint32_t now) {
  return uiDoneStart != 0 && (now - uiDoneStart) < DONE_UI_MS;
}

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

// ---------- LED (PWM, works on Arduino-ESP32 2.x and 3.x) ----------
void ledBegin() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PIN_LED, 5000, 8);
#else
  ledcSetup(0, 5000, 8);
  ledcAttachPin(PIN_LED, 0);
#endif
}

void ledWrite(uint8_t duty) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(PIN_LED, duty);
#else
  ledcWrite(0, duty);
#endif
}

void ledFade(uint32_t now, uint32_t period) {
  float phase = (float)(now % period) / period;
  float s = (sinf(2.0f * PI * phase - PI / 2.0f) + 1.0f) / 2.0f;
  ledWrite((uint8_t)(s * s * 255.0f));
}

void ledBlink(uint32_t now, uint32_t period) {
  ledWrite((now % period) < period / 2 ? 255 : 0);
}

void updateLed(uint32_t now) {
  if (showingDone(now)) {                          // three flashes after a capture, then solid
    uint32_t t = now - uiDoneStart;
    if (t < 900) ledWrite((t % 300) < 150 ? 255 : 0);
    else ledWrite(255);
    return;
  }
  switch (state) {
    case WARMUP:    ledFade(now, 2000);  break;    // slow breathing
    case BASELINE:  ledBlink(now, 500);  break;    // medium blink
    case READY:     ledWrite(255);       break;    // solid on
    case CAPTURING: ledBlink(now, 200);  break;    // fast blink
  }
}

// ---------- Button (debounced). Press fires immediately; hold 3 s fires a long press ----------
BtnEvent pollButton(uint32_t now) {
  static bool lastRead = HIGH, stable = HIGH, longFired = false;
  static uint32_t changedAt = 0;

  bool r = digitalRead(PIN_BTN);
  if (r != lastRead) {
    lastRead = r;
    changedAt = now;
  }
  if (now - changedAt > DEBOUNCE_MS && r != stable) {
    stable = r;
    btnDown = (stable == LOW);
    if (btnDown) {
      btnDownAt = now;
      longFired = false;
      Serial.printf("Button pressed (device is %s)\n", bootPhase ? "starting up" : STATE_NAMES[state]);
      return BTN_PRESS;
    }
    Serial.println("Button released");
  }
  if (btnDown && !longFired && now - btnDownAt >= LONG_PRESS_MS) {
    longFired = true;
    return BTN_LONG;
  }
  return BTN_NONE;
}

// ---------- OLED ----------
void header(const char* text) {
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print("PulmoSense");
  if (ws.connectedClients() > 0) oled.fillCircle(65, 4, 3, SSD1306_WHITE);   // filled = dashboard connected
  else oled.drawCircle(65, 4, 3, SSD1306_WHITE);                             // hollow = nobody connected
  oled.setCursor(128 - 6 * strlen(text), 0);
  oled.print(text);
  oled.drawFastHLine(0, 10, 128, SSD1306_WHITE);
}

void progress(float f) {
  if (f < 0) f = 0;
  if (f > 1) f = 1;
  oled.drawRect(0, 54, 128, 10, SSD1306_WHITE);
  oled.fillRect(2, 56, (int)(124 * f), 6, SSD1306_WHITE);
}

void spinner(int cx, int cy, int r, uint32_t now) {
  float a = now / 120.0f;
  oled.drawCircle(cx, cy, r, SSD1306_WHITE);
  oled.drawLine(cx, cy, cx + (int)(r * cosf(a)), cy + (int)(r * sinf(a)), SSD1306_WHITE);
}

// Simple three-line status screen (used while joining WiFi)
void showMessage(const char* tag, const char* l1, const char* l2, const char* l3) {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  header(tag);
  oled.setTextSize(1);
  oled.setCursor(0, 20);
  oled.print(l1);
  oled.setCursor(0, 32);
  oled.print(l2);
  oled.setCursor(0, 44);
  oled.print(l3);
  oled.display();
}

// Intro: a breath trace draws across the screen, settles into a small wave, then the name types in.
// The LED fades up with it. Takes about 3 s.
void introAnimation() {
  const char* title = "PulmoSense";
  const int titleLen = 10;
  const uint32_t TOTAL = 3000;
  uint32_t t0 = millis();
  uint32_t t;

  while ((t = millis() - t0) < TOTAL) {
    uint32_t duty = t * 255UL / 1800UL;
    ledWrite(duty > 255 ? 255 : (uint8_t)duty);

    if (oledOk) {
      oled.clearDisplay();
      oled.setTextColor(SSD1306_WHITE);

      float p = (t > 1300) ? (t - 1300) / 700.0f : 0.0f;       // 0 while drawing, then 0 -> 1
      if (p > 1) p = 1;
      p = p * p * (3 - 2 * p);
      float cy  = 40 + 12 * p;                                  // wave drifts to the bottom
      float amp = 14 - 10 * p;                                  // and shrinks
      int w = (t < 1300) ? (int)(128UL * t / 1300UL) : 128;     // drawn width
      int prevY = (int)cy;
      for (int x = 0; x < w; x++) {
        float env = (1 - p) * sinf(PI * x / 127.0f) + p;
        int y = (int)(cy + amp * env * sinf(x * 0.16f - t / 150.0f));
        if (x > 0) oled.drawLine(x - 1, prevY, x, y, SSD1306_WHITE);
        prevY = y;
      }
      if (t < 1300 && w > 0) oled.fillCircle(w - 1, prevY, 2, SSD1306_WHITE);

      if (t >= 1200) {                                          // title types in
        int n = (t - 1200) / 90;
        if (n > titleLen) n = titleLen;
        oled.setTextSize(2);
        oled.setCursor(4, 6);
        for (int i = 0; i < n; i++) oled.print(title[i]);
        if (n < titleLen && (t / 120) % 2 == 0) oled.print('_');
      }
      if (t >= 2100) {
        oled.setTextSize(1);
        oled.setCursor(22, 28);
        oled.print("Breath sensing");
      }
      oled.display();
    }
    delay(10);
  }
  ledWrite(0);
}

void drawState(uint32_t now) {
  uint32_t t = now - stateStart;

  if (state == READY && showingDone(now)) {        // friendly result: a face and a kind message, no numbers
    header("DONE");
    int bob = (int)(2 * sinf(now / 200.0f));       // face bobs happily
    int cx = 96, cy = 36 + bob;
    oled.drawCircle(cx, cy, 15, SSD1306_WHITE);
    oled.fillCircle(cx - 5, cy - 4, 2, SSD1306_WHITE);
    if (lastMild) oled.drawFastHLine(cx + 3, cy - 4, 5, SSD1306_WHITE);   // gentle wink
    else oled.fillCircle(cx + 5, cy - 4, 2, SSD1306_WHITE);
    for (int dx = -7; dx <= 7; dx++) oled.drawPixel(cx + dx, cy + 8 - (dx * dx) / 12, SSD1306_WHITE);   // smile: ends higher than the middle
    oled.setTextSize(2);
    oled.setCursor(0, 16);
    oled.print(lastMild ? "Nice!" : "Great!");
    oled.setTextSize(1);
    oled.setCursor(0, 38);
    oled.print(lastMild ? "A little change," : "Your breath looks");
    oled.setCursor(0, 48);
    oled.print(lastMild ? "totally normal" : "fresh and calm");
    return;
  }

  switch (state) {
    case WARMUP: {
      header("WARM-UP");
      oled.setTextSize(2);
      oled.setCursor(0, 18);
      oled.print("Warming up");
      oled.setTextSize(1);
      oled.setCursor(0, 40);
      uint32_t left = t < WARMUP_MS ? (WARMUP_MS - t + 999) / 1000 : 0;
      oled.printf("%lu s left", (unsigned long)left);
      progress((float)t / WARMUP_MS);
      break;
    }
    case BASELINE: {
      header("BASELINE");
      oled.setTextSize(2);
      oled.setCursor(0, 18);
      oled.print("Baseline");
      oled.setTextSize(1);
      oled.setCursor(0, 40);
      oled.print("Keep in clean air");
      spinner(112, 26, 9, now);
      progress((float)t / BASELINE_MS);
      break;
    }
    case READY: {
      header("READY");
      oled.setTextSize(2);
      oled.setCursor(0, 18);
      oled.print("All set!");
      oled.setTextSize(1);
      oled.setCursor(0, 40);
      oled.print("Press the button");
      oled.setCursor(0, 50);
      oled.print("to take a breath");
      int r = 8 + (int)(4 * sinf(now / 400.0f));   // slow breathing ring
      oled.drawCircle(108, 28, r, SSD1306_WHITE);
      oled.fillCircle(108, 28, 3, SSD1306_WHITE);
      break;
    }
    case CAPTURING: {
      header("CAPTURE");
      oled.setTextSize(2);
      oled.setCursor(0, 14);
      oled.print("Breathe");
      oled.setTextSize(1);
      oled.setCursor(0, 36);
      oled.print("Stay close");
      oled.setCursor(0, 45);                       // the only screen that shows sensor numbers
      oled.printf("%.2f %.2f %.2f", latest[0], latest[1], latest[2]);
      // Breathing circle: grows and shrinks on a 4 s cycle, with the seconds left inside it
      float br = (sinf(2.0f * PI * (now % 4000) / 4000.0f - PI / 2.0f) + 1.0f) / 2.0f;
      oled.drawCircle(109, 33, 9 + (int)(7 * br), SSD1306_WHITE);
      unsigned long left = t < CAPTURE_MS ? (CAPTURE_MS - t + 999) / 1000 : 0;
      oled.setCursor(109 - (left > 9 ? 6 : 3), 29);
      oled.print(left);
      progress((float)t / CAPTURE_MS);
      break;
    }
  }
}

// Drawn on top of any screen: button indicator, hold-to-restart bar, "not ready" message
void drawOverlays(uint32_t now) {
  if (btnDown) oled.fillRect(71, 1, 6, 6, SSD1306_WHITE);      // small square while the button is held

  if (btnDown && now - btnDownAt >= HOLD_HINT_MS) {
    float f = (float)(now - btnDownAt - HOLD_HINT_MS) / (float)(LONG_PRESS_MS - HOLD_HINT_MS);
    if (f > 1) f = 1;
    oled.fillRect(0, 34, 128, 30, SSD1306_BLACK);
    oled.drawRect(0, 34, 128, 30, SSD1306_WHITE);
    oled.setTextSize(1);
    oled.setCursor(20, 40);
    oled.print("Hold to restart");
    oled.drawRect(8, 50, 112, 8, SSD1306_WHITE);
    oled.fillRect(10, 52, (int)(108 * f), 4, SSD1306_WHITE);
  } else if (now < toastUntil) {
    oled.fillRect(14, 26, 100, 18, SSD1306_BLACK);
    oled.drawRect(14, 26, 100, 18, SSD1306_WHITE);
    oled.setTextSize(1);
    oled.setCursor(25, 31);
    oled.print("Not ready yet");
  }
}

void drawScreen(uint32_t now) {
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  drawState(now);
  drawOverlays(now);
}

// Waiting-for-dashboard screen: network name, IP, and a sweeping bar
void drawWaiting(uint32_t now) {
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  header("WAITING");
  oled.setTextSize(1);
  oled.setCursor(0, 14);
  oled.printf("WiFi: %s", netName.c_str());
  oled.setCursor(0, 25);
  oled.printf("IP:   %s", netIp.c_str());
  oled.setCursor(0, 37);
  oled.print("Waiting for dashboard");
  oled.setCursor(0, 47);
  oled.print("Press button to skip");
  float ph = (now % 1600) / 1600.0f;                           // bar sweeps left and right
  float tri = ph < 0.5f ? ph * 2 : (1 - ph) * 2;
  int x = (int)(tri * (128 - 24));
  oled.drawFastHLine(0, 61, 128, SSD1306_WHITE);
  oled.fillRect(x, 59, 24, 5, SSD1306_WHITE);
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
    // Commands: {"cmd":"capture"} and {"cmd":"restart"}.
    // The library null-terminates text payloads, so strstr is safe here.
    const char* msg = (const char*)payload;
    if (bootPhase) return;                         // ignore commands until the boot sequence is done
    if (strstr(msg, "\"capture\"") && state == READY) {
      Serial.println("Capture requested from the website.");
      setState(CAPTURING);
    } else if (strstr(msg, "\"restart\"")) {
      Serial.println("Restart requested from the website.");
      restartWarmup();
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
  uiDoneStart = 0;
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

void restartWarmup() {
  hasBaseline = false;
  Serial.println("Restarting warm-up.");
  ws.broadcastTXT("{\"type\":\"restart\"}");
  setState(WARMUP);
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
  lastMild = false;
  for (int i = 0; i < 3; i++) if (ratio[i] > RATIO_HIGH) lastMild = true;
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
  netName = AP_SSID;
  netIp = WiFi.softAPIP().toString();
  Serial.printf("Own network \"%s\" up. Device IP %s\n", AP_SSID, netIp.c_str());
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
  int dots = 0;
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    char line[22];
    snprintf(line, sizeof(line), "Joining%.*s", dots % 4, "...");
    showMessage("WIFI", line, WIFI_SSID, "");
    Serial.print(".");
    delay(300);
    dots++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    netName = WIFI_SSID;
    netIp = WiFi.localIP().toString();
    Serial.printf("\nJoined WiFi. Device IP %s\n", netIp.c_str());
    showMessage("WIFI", "Joined", netIp.c_str(), "");
    delay(800);
  } else {
    Serial.println("\nCould not join WiFi. Falling back to own network.");
    showMessage("WIFI", "Join failed", "Using own network", "");
    delay(1500);
    startOwnNetwork();
  }
}

// Blocks until a dashboard connects over WebSocket, or the button is pressed to skip.
// The sensor heaters are powered the whole time, so they keep warming up while we wait.
void waitForConnection() {
  Serial.println("Waiting for the dashboard to connect (press the button to skip)...");
  uint32_t lastFrame = 0;
  bool connected = false;

  while (true) {
    ws.loop();
    uint32_t now = millis();
    if (pollButton(now) == BTN_PRESS) {
      Serial.println("Skipped waiting for the dashboard.");
      break;
    }
    if (ws.connectedClients() > 0) {
      connected = true;
      break;
    }
    ledFade(now, 1600);
    if (oledOk && now - lastFrame >= FRAME_MS) {
      lastFrame = now;
      drawWaiting(now);
      oled.display();
    }
    delay(5);
  }

  if (connected) {
    Serial.println("Dashboard connected.");
    uint32_t t0 = millis();
    while (millis() - t0 < 1200) {
      ws.loop();
      uint32_t t = millis() - t0;
      ledWrite((t % 400) < 200 ? 255 : 0);             // two quick flashes
      if (oledOk) {
        oled.clearDisplay();
        oled.setTextColor(SSD1306_WHITE);
        header("LINKED");
        oled.drawLine(50, 28, 58, 36, SSD1306_WHITE);  // check mark
        oled.drawLine(50, 29, 58, 37, SSD1306_WHITE);
        oled.drawLine(58, 36, 78, 16, SSD1306_WHITE);
        oled.drawLine(58, 37, 78, 17, SSD1306_WHITE);
        oled.setTextSize(1);
        oled.setCursor(7, 46);
        oled.print("Dashboard connected");
        oled.display();
      }
      delay(30);
    }
  }
  ledWrite(0);
}

// ---------- Setup ----------
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\nPulmoSense start");

  pinMode(PIN_BTN, INPUT_PULLUP);
  ledBegin();
  for (int i = 0; i < 3; i++) analogSetPinAttenuation(PINS[i], ADC_11db);

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  if (!oledOk) Serial.println("OLED not found at 0x3C. Running without the display.");

  introAnimation();

  startNetwork();
  if (MDNS.begin(HOST_NAME)) Serial.printf("Also reachable as %s.local\n", HOST_NAME);

  ws.begin();
  ws.onEvent(onWsEvent);
  Serial.println("WebSocket server on port 81");

  waitForConnection();
  bootPhase = false;

  readAll(latest);
  setState(WARMUP);
}

// ---------- Loop ----------
void loop() {
  static uint32_t lastSample = 0, lastLive = 0, lastWarmPrint = 0, lastFrame = 0;
  ws.loop();

  uint32_t now = millis();

  BtnEvent e = pollButton(now);
  if (e == BTN_PRESS) {
    if (state == READY) {
      setState(CAPTURING);
    } else {
      Serial.printf("Button ignored: device is %s, not ready yet.\n", STATE_NAMES[state]);
      toastUntil = now + 1500;
    }
  } else if (e == BTN_LONG) {
    restartWarmup();
  }

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
      uiDoneStart = millis();                      // show the result screen and LED flashes
    }
  }

  updateLed(now);

  if (oledOk && now - lastFrame >= FRAME_MS) {
    lastFrame = now;
    drawScreen(now);
    oled.display();
  }

  if (now - lastLive >= LIVE_MS) {
    lastLive = now;
    sendLive(now);
  }
}
