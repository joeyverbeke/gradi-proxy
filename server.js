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

const CONTROL_CFG = {
  confStart: Number.parseFloat(process.env.CONF_START_THRESHOLD ?? '') || 0.95,
  confRearm: Number.parseFloat(process.env.CONF_REARM_THRESHOLD ?? '') || 0.8,
  confExit: Number.parseFloat(process.env.CONF_EXIT_THRESHOLD ?? '') || 0.4,
  proxExit: Number.isNaN(Number(process.env.PROX_EXIT_LEVEL)) ? 5 : Number(process.env.PROX_EXIT_LEVEL),
  leaveMs: Number.isNaN(Number(process.env.LEAVE_HOLD_MS)) ? 1000 : Number(process.env.LEAVE_HOLD_MS),
  startDelay: Number.isNaN(Number(process.env.START_DELAY_MS)) ? 600 : Number(process.env.START_DELAY_MS),
};

const controlState = {
  autoArmed: true,
  sequenceActive: false,
  startPending: false,
  stopPending: false,
  leaveCandidateSince: null,
  lastStatus: null,
  lastStart: null,
  startTimer: null,
};

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

function controlLog(event, info = {}) {
  const payload = {
    type: 'control-log',
    event,
    ts: Date.now(),
    ...info,
  };
  console.log(`[CTRL] ${event}`, JSON.stringify(info));
  broadcast(payload);
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
  if (data.reason) result.reason = data.reason;
  return result;
}

let serialPort = null;

function clearStartTimer() {
  if (controlState.startTimer) {
    clearTimeout(controlState.startTimer);
    controlState.startTimer = null;
  }
}

function requestStart(reason, extra = {}) {
  if (!serialPort) {
    controlLog('start-skipped', { reason: 'no-serial', requestedBy: reason, ...extra });
    return false;
  }
  if (controlState.sequenceActive || controlState.startPending) {
    return false;
  }
  controlState.startPending = true;
  controlState.autoArmed = false;
  controlState.lastStart = {
    reason,
    requestedAt: Date.now(),
    ...extra,
  };
  clearStartTimer();
  controlLog('start-request', { reason, delayMs: CONTROL_CFG.startDelay, ...extra });
  const delay = Math.max(0, CONTROL_CFG.startDelay);
  controlState.startTimer = setTimeout(() => {
    controlState.startTimer = null;
    controlLog('start-dispatch', { reason, delayMs: delay, ...extra });
    serialPort.write('START\n', (err) => {
      if (err) {
        controlLog('start-error', { reason, error: err.message });
      }
    });
  }, delay);
  return true;
}

function requestStop(reason, extra = {}) {
  if (!serialPort) {
    controlLog('stop-skipped', { reason: 'no-serial', requestedBy: reason, ...extra });
    return false;
  }
  if (controlState.stopPending) {
    return false;
  }
  clearStartTimer();
  controlState.stopPending = true;
  controlLog('stop-request', { reason, ...extra });
  serialPort.write('STOP\n', (err) => {
    if (err) {
      controlLog('stop-error', { reason, error: err.message });
    }
  });
  return true;
}

function handleSequenceLog(seq) {
  if (!seq || !seq.action) return;
  const now = Date.now();
  switch (seq.action) {
    case 'START':
      controlState.sequenceActive = true;
      controlState.startPending = false;
      controlState.stopPending = false;
      controlState.leaveCandidateSince = null;
      clearStartTimer();
      controlLog('sequence-started', {
        time_ms: seq.time_ms,
        reason: controlState.lastStart ? controlState.lastStart.reason : null,
        queued: controlState.lastStart,
        slots: seq.slots,
      });
      break;
    case 'END':
      controlState.sequenceActive = false;
      controlState.stopPending = false;
      controlState.leaveCandidateSince = null;
      clearStartTimer();
      controlState.lastStart = null;
      controlLog('sequence-ended', { time_ms: seq.time_ms, at: now });
      break;
    case 'CANCEL':
      controlState.sequenceActive = false;
      controlState.startPending = false;
      controlState.stopPending = false;
      controlState.leaveCandidateSince = null;
      controlState.lastStart = null;
      clearStartTimer();
      controlLog('sequence-cancelled', { time_ms: seq.time_ms, reason: seq.reason || null });
      break;
    default:
      break;
  }
}

function handleStatus(status) {
  if (!status) return;
  const now = Date.now();
  controlState.lastStatus = status;

  const confidence = typeof status.confidence === 'number' && !Number.isNaN(status.confidence)
    ? status.confidence
    : undefined;
  const prox = typeof status.prox === 'number' && !Number.isNaN(status.prox) ? status.prox : undefined;

  const runningOrPending = controlState.sequenceActive || controlState.startPending;

  if (runningOrPending) {
    if (!controlState.stopPending) {
      const confidenceLow = confidence !== undefined && confidence <= CONTROL_CFG.confExit;
      const proxLow = prox !== undefined && prox <= CONTROL_CFG.proxExit;
      if (confidenceLow && proxLow) {
        if (controlState.leaveCandidateSince == null) {
          controlState.leaveCandidateSince = now;
        } else if (now - controlState.leaveCandidateSince >= CONTROL_CFG.leaveMs) {
          requestStop('person-left', { confidence, prox });
        }
      } else {
        controlState.leaveCandidateSince = null;
      }
    } else {
      controlState.leaveCandidateSince = null;
    }
    return;
  }

  controlState.leaveCandidateSince = null;

  if (controlState.stopPending) {
    return;
  }

  if (!controlState.autoArmed) {
    if (status.state === 'IDLE') {
      controlState.autoArmed = true;
      controlLog('auto-rearm', { reason: 'state-idle' });
    } else if (confidence !== undefined && confidence <= CONTROL_CFG.confRearm) {
      controlState.autoArmed = true;
      controlLog('auto-rearm', { reason: 'confidence-drop', confidence });
    }
  }

  if (
    controlState.autoArmed &&
    status.state === 'PRESENCE' &&
    confidence !== undefined &&
    confidence >= CONTROL_CFG.confStart
  ) {
    requestStart('auto-confidence', { confidence, time_ms: status.time_ms });
  }
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
    serialPort = serial;
    controlLog('serial-open', { port: portPath, baud: BAUD });

    serial.on('error', (err) => {
      console.error('Serial error:', err.message);
      controlLog('serial-error', { error: err.message });
    });

    serial.on('close', () => {
      controlLog('serial-close', {});
      serialPort = null;
      clearStartTimer();
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
          handleStatus(status);
          broadcast({ type: 'status', ...status });
          continue;
        }
        const seq = parseSequenceLine(line);
        if (seq) {
          handleSequenceLog(seq);
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
    ws.send(JSON.stringify({ type: 'hello', baud: BAUD, serial: !!serialPort }));

    ws.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        console.warn('WS message parse error:', err.message);
        return;
      }
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'start-sequence':
          if (!requestStart('manual-ui', { from: 'ws' })) {
            ws.send(JSON.stringify({ type: 'esp-log', text: 'INFO start request ignored (busy or unavailable)' }));
          }
          break;
        case 'stop-sequence':
          if (!requestStop('manual-ui', { from: 'ws' })) {
            ws.send(JSON.stringify({ type: 'esp-log', text: 'INFO stop request ignored (not running)' }));
          }
          break;
        default:
          break;
      }
    });
  });

  server.listen(HTTP_PORT, () => {
    console.log(`HTTP: http://localhost:${HTTP_PORT}`);
  });
}

controlLog('controller-init', { config: CONTROL_CFG });

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
