// Minimal serial → WebSocket → frontend bridge
// Env: SERIAL_PORT=/dev/tty.usbmodem... BAUD=115200 PORT=3000

const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { SerialPort } = require('serialport');

const HTTP_PORT = Number(process.env.PORT || 3007);
const BAUD = Number(process.env.BAUD || 115200);
const SERIAL_HINT = process.env.SERIAL_PORT || '';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function parseLine(line) {
  // Example: t=794125 ms | prox=11
  // Return { t: number, prox: number } or null
  const m = line.match(/t=(\d+)\s*ms\s*\|\s*prox=(\d+)/i);
  if (!m) return null;
  return { t: Number(m[1]), prox: Number(m[2]) };
}

async function pickSerialPort() {
  // If env provided, use it directly
  if (SERIAL_HINT) {
    return SERIAL_HINT;
  }
  const ports = await SerialPort.list();
  // Try to choose a likely ESP32 device
  const preferred = ports.find((p) => {
    const id = `${p.path} ${p.manufacturer || ''} ${p.friendlyName || ''}`.toLowerCase();
    return id.includes('esp') || id.includes('seeed') || id.includes('silicon labs') || id.includes('wch');
  });
  return (preferred || ports[0] || {}).path;
}

async function start() {
  const portPath = await pickSerialPort();
  if (!portPath) {
    console.error('No serial ports found. Set SERIAL_PORT env to your device path.');
  } else {
    console.log(`Opening serial: ${portPath} @ ${BAUD}`);
  }

  let serial;
  let buffer = '';
  if (portPath) {
    serial = new SerialPort({ path: portPath, baudRate: BAUD });

    serial.on('error', (err) => {
      console.error('Serial error:', err.message);
    });

    serial.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const parsed = parseLine(line);
        if (parsed) {
          broadcast({ type: 'sample', ...parsed });
        } else if (/^SEQ/i.test(line) || /^ERR/i.test(line)) {
          broadcast({ type: 'esp-log', text: line });
        }
      }
      // Safety: avoid unbounded buffer
      if (buffer.length > 4096) buffer = buffer.slice(-2048);
    });
  }

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', baud: BAUD, serial: !!serial }));

    ws.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        console.warn('WS message parse error:', err.message);
        return;
      }
      if (msg && msg.type === 'start-sequence') {
        if (serial) {
          serial.write('START\n', (err) => {
            if (err) console.error('Serial write error:', err.message);
          });
        } else {
          ws.send(JSON.stringify({ type: 'esp-log', text: 'ERR no-serial-port' }));
        }
      }
    });
  });

  server.listen(HTTP_PORT, () => {
    console.log(`HTTP: http://localhost:${HTTP_PORT}`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
