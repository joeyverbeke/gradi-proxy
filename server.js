// Minimal serial → WebSocket → frontend bridge
// Config: see .env for SERIAL_PORT, BAUD, PORT

require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { SerialPort } = require('serialport');

const HTTP_PORT = Number(process.env.PORT || 3007);
const BAUD = Number(process.env.BAUD || 115200);
const serialEnv = process.env.SERIAL_PORT || 'ttyACM0';
const SERIAL_HINT = serialEnv.startsWith('/') ? serialEnv : `/dev/${serialEnv}`;

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

function parseSampleLine(line) {
  const m = line.match(/t=(\d+)\s*ms\s*\|\s*prox=(\d+)/i);
  if (!m) return null;
  return { t: Number(m[1]), prox: Number(m[2]) };
}

function parseKeyValueSegments(remainder) {
  if (!remainder) return {};
  const segments = remainder.split('|');
  const data = {};
  segments.forEach((seg) => {
    const trimmed = seg.trim();
    if (!trimmed) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) data[key] = value;
  });
  return data;
}

function parseBlinkLine(line) {
  if (!line.startsWith('BLINK')) return null;
  const data = parseKeyValueSegments(line.slice('BLINK'.length).trim());
  if (!data.time_ms) return null;
  const toNum = (key) => (key in data ? Number(data[key]) : undefined);
  return {
    time_ms: Number(data.time_ms),
    prox: toNum('prox'),
    mean: toNum('mean'),
    sigma: toNum('sigma'),
    zRise: toNum('zRise'),
    zDrop: toNum('zDrop'),
    polarity: data.polarity || null,
    confidence: toNum('confidence'),
    blinks: toNum('blinks'),
    raw: line,
  };
}

function parseStatusLine(line) {
  if (!line.startsWith('STATUS')) return null;
  const data = parseKeyValueSegments(line.slice('STATUS'.length).trim());
  if (!data.time_ms) return null;
  const toNum = (key) => (key in data ? Number(data[key]) : undefined);
  const status = {
    time_ms: Number(data.time_ms),
    state: data.state || null,
    prox: toNum('prox'),
    confidence: toNum('confidence'),
    blinks: toNum('blinks'),
    raw: line,
  };
  if ('mean' in data) status.mean = Number(data.mean);
  if ('sigma' in data) status.sigma = Number(data.sigma);
  if ('zRise' in data) status.zRise = Number(data.zRise);
  if ('zDrop' in data) status.zDrop = Number(data.zDrop);
  return status;
}

function parseSequenceLine(line) {
  const m = line.match(/^SEQ\s+(START|END|CANCEL)\b/i);
  if (!m) return null;
  const action = m[1].toUpperCase();
  const remainder = line.slice(m[0].length).trim();
  const data = parseKeyValueSegments(remainder);
  const result = { action, raw: line };
  if (data.time_ms) result.time_ms = Number(data.time_ms);
  if (data.lead_ms) result.lead_ms = Number(data.lead_ms);
  if (data.slots) {
    result.slots = data.slots
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
  }
  return result;
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
    console.error('No serial ports found. Update SERIAL_PORT in .env to your device path.');
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
        const blink = parseBlinkLine(line);
        if (blink) {
          broadcast({ type: 'blink-event', ...blink });
          continue;
        }
        const status = parseStatusLine(line);
        if (status) {
          broadcast({ type: 'status', ...status });
          continue;
        }
        const seq = parseSequenceLine(line);
        if (seq) {
          broadcast({ type: 'sequence-log', ...seq });
          broadcast({ type: 'esp-log', text: line });
          continue;
        }
        const sample = parseSampleLine(line);
        if (sample) {
          broadcast({ type: 'sample', ...sample });
          continue;
        }
        if (/^ERR/i.test(line)) {
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
