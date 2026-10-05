# PulmoSense web app

Browser data logger and viewer for the PulmoSense prototype (ESP32 + MQ-3, MQ-135, MQ-7). It connects to the device over WebSocket, plots the sensor voltages live, records sessions in the browser, and exports CSV.

Prototype. Not a medical device. Values are sensor voltages, not a diagnosis.

## Run it

```
npm install
npm run dev
```

Open the URL Vite prints (http://localhost:5173). The dev server also listens on your LAN address, so a phone on the same network can open `http://<laptop-ip>:5173`. To serve the built app: `npm run build` then `npm run preview`.

**Serve it over http, not https.** Browsers block `ws://` connections from pages loaded over `https://`, so the app cannot reach the device from an https host. Run it from `localhost` as above. If you open it from an https URL and enter a `ws://` address, the app shows a message explaining this.

## Connect to the device

**Device's own network (default).**
1. Power the device. It creates a WiFi network named `PulmoSense`.
2. Join `PulmoSense` from the laptop. The laptop loses internet while joined; the app works offline once loaded, so start `npm run dev` (or open the page) first if you need to.
3. In the app, keep the address `ws://192.168.4.1:81` and press Connect.

**Shared WiFi.** If the firmware joins an existing network, use the IP it prints over serial (`ws://<ip>:81`), or try `ws://pulmosense.local:81` (mDNS does not work on every device).

If the connection drops, the app retries after 1 s, 2 s, 5 s, then every 5 s until you press Disconnect. A socket that goes silent for 5 s is treated as dropped, since a powered-off ESP32 sends no close.

**Demo mode** runs a simulator that sends the same messages without hardware (20 s warm-up, then baseline, then ready). Use "Start capture" for a 5 s capture.

**Start capture** (shown once the device is Ready) sends `{"cmd":"capture"}` over the WebSocket, which the firmware treats the same as its physical button. This needs the firmware in `firmware/pulmosense/` (or the same `onWsEvent` change in yours); older firmware ignores the command and the app tells you so after a couple of seconds. This is the only message the app ever sends. Simulated data is tagged in the top bar, in the sessions list, and as `simulated` in every CSV row.

## Using it

- **Chart**: window 1 / 5 / 15 min or all, fixed 0 to 5 V or auto-scale, pause/resume (space). Incoming data is kept while paused. Lines break across dropouts longer than 2 s. Shaded bands are captures; dashed lines are the baseline per sensor.
- **Captures table**: one row per sensor per capture, with volts, ratio vs baseline, and a descriptor: Below baseline (< 0.90), Near baseline (0.90 to 1.10), Above baseline (> 1.10). These are display bins for the change in voltage, set in `src/config.ts`, not clinical thresholds. The bar chart under the table compares ratios across captures.
- **Recording**: Start recording stores every reading and event in IndexedDB, written in batches every 2 s. A connection drop keeps recording on and leaves the gap in the data. Sessions survive a page reload.
- **Sessions**: rename, open (read-only chart and captures; drag to zoom), export CSV, delete.
- **Device log**: connection changes, restarts, malformed frames.

### CSV

Readings: `iso_time,elapsed_s,mq3_v,mq135_v,mq7_v,state,event,source`. Times are the browser clock on arrival (UTC ISO 8601). `event` holds `baseline`, `capture start` or `capture N`, placed on the first reading at or after the event.

Captures: `capture,iso_time,sensor,volts,ratio_vs_baseline,descriptor,source`.

Files are UTF-8 with a BOM, so Excel opens them with the columns intact.

## Code

```
src/config.ts        sensor names, ratio cut-offs, timing constants
src/parse/           message parser (pure) + tests
src/sources/         DataSource interface, WebSocket source, simulator
src/state/           store (live state, recording), series helpers, IndexedDB, CSV
src/ui/              React components, uPlot chart
```

`npm test` runs the parser and series/CSV tests (Vitest).

**Why uPlot**: it draws tens of thousands of points on canvas cheaply, has no animations to turn off, and supports null gaps natively, which gives the dropout breaks for free. Chart.js would need animations disabled and decimation tuned to match. Fonts are bundled from npm; there are no runtime network calls other than the device WebSocket.

## Known limitations

- MQ sensors are cross-sensitive and drift with humidity and temperature. There is no humidity or temperature compensation in this build.
- Readings are only comparable within one session after one baseline.
- First-time burn-in (about 24 h) and the 5 min warm-up per power-on affect stability.
- The device has no wall clock, so timestamps are the browser's arrival time and include network delay.
- Joining the device's own network disconnects the laptop from the internet. Campus or public WiFi may block device-to-device traffic; in that case use the device's own network or a phone hotspot.
- The app must be served over http, not https.
- After a device restart, capture numbers start again from 1. The capture table shows the time of each capture to tell them apart.
