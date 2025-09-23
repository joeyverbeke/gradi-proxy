ESP Proximity Visualizer (MVP)

What it does
- Reads serial lines like `t=794125 ms | prox=11` from your ESP.
- Broadcasts samples to the browser over WebSocket.
- Draws a small square at a random position whenever prox crosses the threshold upward.
- Threshold is adjustable (0..175) via slider.

Quick start
1) Install deps:
   npm install

2) Start the server (adjust envs as needed):
   # optionally set the serial device path
   # SERIAL_PORT=/dev/tty.usbmodemXXX BAUD=115200 PORT=3000 \
   npm start

3) Open the UI:
   http://localhost:3000

Environment variables
- `SERIAL_PORT`: serial device path; if omitted, the server tries to auto-pick a likely ESP port.
- `BAUD`: serial baud (default 115200).
- `PORT`: HTTP port (default 3000).

Notes
- The UI triggers on upward crossings only: last < threshold && curr >= threshold.
- If auto-detect fails, set SERIAL_PORT explicitly. On macOS this is often `/dev/tty.usbmodem*` or `/dev/tty.usbserial*`.

