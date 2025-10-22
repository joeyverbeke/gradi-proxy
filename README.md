Gradi Proxy
===========

This repository contains the full software surface for running the Gradi blink proxy rig:

- `gradi-proxy-esp/`: Arduino sketch for the XIAO ESP32S3 + DRV8833 + VCNL4040 hardware. The firmware streams proximity samples, blink detection metrics, and responds to `START` / `STOP` serial commands that drive the pump/valve sequence.
- `server.js`: Node.js bridge that opens the serial port, parses firmware output, controls blink sequences based on confidence thresholds, and broadcasts structured data to the frontend via WebSocket.
- `public/`: Browser dashboard that visualises proximity samples, blink events, and pump sequence state.

Prerequisites
-------------

- Node.js 18+
- Arduino-flashed ESP32S3 running `gradi-proxy-esp/gradi-proxy-esp.ino`

Setup
-----

```bash
npm install
cp .env.example .env
# edit .env to match your serial port and preferred thresholds
```

`.env.example` documents every configuration option; copy it and adjust values for your environment (serial path, baud rate, auto-control thresholds).

Running
-------

```bash
npm start
# server logs: HTTP: http://localhost:3007
```

Open `http://localhost:3007` in a browser to load the dashboard. The UI auto-connects to `/ws`, streams proximity data, and mirrors controller state. Manual start/stop buttons emit JSON messages that route back through the Node controller, so manual and auto control share the same path.

For engineering diagnostics, the legacy dashboard remains available at `http://localhost:3007/debug/`.

Auto Control Overview
---------------------

The firmware continuously emits `STATUS` lines with presence (`state`), proximity (`prox`), and blink confidence (`confidence`). The Node controller monitors these and:

- Auto-starts a sequence when confidence stays above `CONF_START_THRESHOLD` while presence is `PRESENCE` and no run is active.
- Re-arms after a run only when confidence drops below `CONF_REARM_THRESHOLD` or the firmware reports `state=IDLE` (wearer left).
- Auto-cancels during a run if confidence falls below `CONF_EXIT_THRESHOLD` and proximity stays under `PROX_EXIT_LEVEL` for `LEAVE_HOLD_MS`.

Thresholds live in environment variables (defaults in `.env.example`):

| Variable | Default | Description |
| --- | --- | --- |
| `SERIAL_PORT` | ttyACM0 | Serial device path; leave unset to auto-pick |
| `BAUD` | 115200 | Serial baud rate |
| `PORT` | 3007 | HTTP/WebSocket port |
| `CONF_START_THRESHOLD` | 0.95 | Confidence needed to auto-start |
| `CONF_REARM_THRESHOLD` | 0.80 | Confidence level that re-arms auto-start |
| `CONF_EXIT_THRESHOLD` | 0.40 | Combined with low proximity triggers auto-cancel |
| `PROX_EXIT_LEVEL` | 5 | Proximity count considered “no wearer” |
| `LEAVE_HOLD_MS` | 1000 | Dwell time before auto-cancelling |
| `START_DELAY_MS` | 600 | Delay between auto-accept and issuing `START` |

Controller logs (`[CTRL] …`) appear in the Node terminal and are mirrored to the frontend as `control-log` messages so you can audit every START/STOP decision.

Firmware Snapshot
-----------------

`gradi-proxy-esp/gradi-proxy-esp.ino` configures the VCNL4040 sensor (200 Hz sampling), runs the pump/valve state machine for 16 frames × 4 slots, tracks blink statistics (presence gating, EWMA baseline), and emits:

- Raw proximity lines (`t=<ms> | prox=<count>`)
- `STATUS …` summaries with confidence, mean, sigma, etc.
- `BLINK …` events detailing each detected blink
- `SEQ START/END/CANCEL …` messages for the pump sequence lifecycle

Repository Layout
-----------------

```
gradi-proxy/
├── gradi-proxy-esp/
├── public/
├── server.js
├── package.json
├── package-lock.json
├── .env.example
└── README.md
```

Troubleshooting
---------------

- **No serial port found**: set `SERIAL_PORT` in `.env` to the correct device. On macOS this is usually `/dev/tty.usbmodem*`.
- **Auto-start never fires**: inspect `STATUS` lines (or UI stats) to confirm confidence reaches the threshold; lower `CONF_START_THRESHOLD` if needed.
- **Sequences cancel unexpectedly**: raise `LEAVE_HOLD_MS` or adjust `CONF_EXIT_THRESHOLD` / `PROX_EXIT_LEVEL` for your sensor fit.
- **UI not updating**: ensure the browser hits the same host/port as the Node server and that `/ws` stays connected (check DevTools console).

With firmware streaming, the Node controller running, and the dashboard open, the system will trigger pump sequences automatically on confident blinks and stop safely when the wearer leaves. Adjust thresholds to match your hardware and environment.
