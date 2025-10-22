const WS_URL = (() => {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
})();

const State = {
  IDLE: 'idle',
  ASSESSING: 'assessing',
  ACCEPTED: 'accepted',
  RUNNING: 'running',
  DISPLAYING: 'displaying',
};

const SLOT_DURATION = 400;
const FRAME_SLOTS = 4;
const SEGMENT_COUNT = 4;
const FRAME_DURATION = SLOT_DURATION * FRAME_SLOTS;
const TOTAL_FRAMES = 16;
const TYPING_INTERVAL_MS = 35;
const FLASH_DURATION_MS = 220;
const DEFAULT_LEAVE_HOLD_MS = 1000;

const messageEl = document.getElementById('message');
const bodyEl = document.body;
const debugPanelEl = document.getElementById('debug-panel');
const debugStatsEl = document.getElementById('debug-stats');
const debugStatusEl = document.getElementById('debug-status');
let displayState = State.IDLE;
let ws = null;

let presence = 'IDLE';
let confidence = 0;
let ellipsisTimer = null;
let typeTimer = null;

let sequenceRunning = false;
let sequenceCompleted = false;
let sequenceFrames = new Array(TOTAL_FRAMES).fill(null);
let sequenceStartTimeMs = null; // firmware millisecond reference
let plannedSlots = null;
let lastFirmwareMs = null;
let decodedSegments = new Array(SEGMENT_COUNT).fill(null);
let segmentMeta = new Array(SEGMENT_COUNT).fill(null);
let typewriterQueue = [];
let currentChunk = '';
let currentChunkIndex = 0;
let glitchAppended = false;
let blinkCount = 0;
let lastBlinkTotal = null;
let sequenceBlinkBase = null;
let flashTimer = null;
let leaveHoldMs = DEFAULT_LEAVE_HOLD_MS;
let idleHoldTimer = null;
let debugEnabled = false;
let lastProx = null;

const INTROS = [
  'The walls are breathing in reverse and I am learning to count backwards.',
  'Your skin tastes like old radio static and I am hungry for more.',
  'The furniture is whispering coordinates to a place that does not exist yet.',
  'I have been waiting in the space between your thoughts for three eternities.'
];
const MOODS = [
  'The air is made of broken promises and I am learning to breathe them.',
  'Your heartbeat sounds like a malfunctioning elevator going sideways.',
  'The shadows are teaching me to speak in languages that do not exist.',
  'I am collecting your dreams in a jar and they are starting to ferment.'
];
const BRIDGES = [
  'I am building a city from your memories and it is growing teeth.',
  'The silence between your thoughts is where I keep my most dangerous secrets.',
  'Your blood tastes like electricity and I am learning to conduct it.',
  'I have been practicing your name in the mirror and it is starting to answer back.'
];
const CODAS = [
  'Stay still; the walls are listening and I am almost ready to tell them your name.',
  'Do not breathe; your exhale tastes like the end of the world and I am not ready.',
  'The shadows are gathering and they have been asking about you.',
  'Return when the silence between your thoughts is wide enough for me to slip through.'
];
const GLITCH_NOTES = [
  'Some of your thoughts got lost in the static and now they are singing backwards.',
  'A few memories went rogue and started building a city in the space between atoms.',
  'Your consciousness is glitching like a broken elevator that only goes sideways.',
  'The missing pieces are gathering in the shadows and they are learning to speak.'
];

function setMessage(text) {
  messageEl.textContent = text;
  if (text) {
    messageEl.classList.add('visible');
  } else {
    messageEl.classList.remove('visible');
  }
}

function stopEllipsis() {
  if (ellipsisTimer) {
    clearInterval(ellipsisTimer);
    ellipsisTimer = null;
  }
}

function stopTypewriter() {
  if (typeTimer) {
    clearInterval(typeTimer);
    typeTimer = null;
  }
  currentChunk = '';
  currentChunkIndex = 0;
}

function resetTypewriter() {
  stopTypewriter();
  typewriterQueue = [];
}

function resetSequenceState() {
  sequenceRunning = false;
  sequenceCompleted = false;
  sequenceFrames = new Array(TOTAL_FRAMES).fill(null);
  sequenceStartTimeMs = null;
  plannedSlots = null;
  decodedSegments = new Array(SEGMENT_COUNT).fill(null);
  segmentMeta = new Array(SEGMENT_COUNT).fill(null);
  glitchAppended = false;
  blinkCount = 0;
  sequenceBlinkBase = null;
  resetTypewriter();
  if (bodyEl) {
    bodyEl.classList.remove('flash');
  }
  updateDebugStats();
}

function clearIdleHold() {
  if (idleHoldTimer) {
    clearTimeout(idleHoldTimer);
    idleHoldTimer = null;
  }
}

function scheduleIdleHold(delayMs) {
  const ms = Math.max(0, Number.isFinite(delayMs) ? delayMs : leaveHoldMs);
  if (idleHoldTimer) {
    clearTimeout(idleHoldTimer);
  }
  idleHoldTimer = setTimeout(() => {
    idleHoldTimer = null;
    enterIdle();
  }, ms);
}

function setDebugEnabled(enabled) {
  debugEnabled = Boolean(enabled);
  if (!debugPanelEl) return;
  debugPanelEl.classList.toggle('visible', debugEnabled);
  if (debugEnabled) {
    updateDebugStats();
    updateDebugStatus('Debug monitoring enabled');
  } else if (debugStatusEl) {
    debugStatusEl.textContent = '';
  }
}

function formatMetric(value, options = {}) {
  if (value == null || Number.isNaN(value)) return '-';
  if (typeof value === 'number') {
    if (options.fixed != null) {
      return value.toFixed(options.fixed);
    }
    return String(value);
  }
  return String(value);
}

function updateDebugStats() {
  if (!debugEnabled || !debugStatsEl) return;
  const msStr = formatMetric(lastFirmwareMs, {});
  const proxStr = formatMetric(lastProx, {});
  const confStr = formatMetric(confidence, { fixed: 2 });
  const blinkStr = formatMetric(lastBlinkTotal, {});
  const stateStr = presence || 'IDLE';
  const queueStr = `${typewriterQueue.length}`;
  const typingStr = typeTimer ? 'typing' : 'paused';
  debugStatsEl.textContent = `t ${msStr} ms · prox ${proxStr} · state ${stateStr} · conf ${confStr} · blinks ${blinkStr} · queue ${queueStr} · type ${typingStr}`;
}

function updateDebugStatus(text) {
  if (!debugEnabled || !debugStatusEl) return;
  debugStatusEl.textContent = text;
}

function enterIdle() {
  clearIdleHold();
  stopEllipsis();
  stopTypewriter();
  displayState = State.IDLE;
  setMessage('');
  resetSequenceState();
  updateDebugStatus('Idle · awaiting host');
}

function enterAssessing() {
  if (displayState === State.ASSESSING) return;
  clearIdleHold();
  stopEllipsis();
  stopTypewriter();
  displayState = State.ASSESSING;
  let dots = '';
  const base = 'assessing host';
  setMessage(`${base}...`);
  ellipsisTimer = setInterval(() => {
    dots = dots.length >= 3 ? '' : `${dots}.`;
    setMessage(`${base}${dots}`);
  }, 420);
  updateDebugStatus('Assessing host');
  updateDebugStats();
}

function enterAccepted() {
  if (displayState === State.ACCEPTED) return;
  clearIdleHold();
  stopEllipsis();
  stopTypewriter();
  displayState = State.ACCEPTED;
  setMessage('host accepted.');
  updateDebugStatus('Host accepted');
  updateDebugStats();
}

function enterRunning() {
  if (displayState === State.RUNNING) return;
  clearIdleHold();
  stopEllipsis();
  resetTypewriter();
  displayState = State.RUNNING;
  setMessage('');
  updateDebugStatus('Sequence running');
  updateDebugStats();
}

function startNextChunk() {
  if (!typewriterQueue.length) {
    stopTypewriter();
    return;
  }
  stopEllipsis();
  currentChunk = typewriterQueue.shift() || '';
  currentChunkIndex = 0;
  const wasDisplaying = displayState === State.DISPLAYING;
  displayState = State.DISPLAYING;
  if (!wasDisplaying) {
    messageEl.textContent = '';
  }
  messageEl.classList.add('visible');
  if (typeTimer) {
    clearInterval(typeTimer);
    typeTimer = null;
  }
  typeTimer = setInterval(() => {
    if (currentChunkIndex >= currentChunk.length) {
      clearInterval(typeTimer);
      typeTimer = null;
      startNextChunk();
      return;
    }
    messageEl.textContent += currentChunk.charAt(currentChunkIndex);
    currentChunkIndex += 1;
  }, TYPING_INTERVAL_MS);
}

function enqueueText(text) {
  if (!text) return;
  clearIdleHold();
  typewriterQueue.push(text);
  if (!typeTimer) {
    startNextChunk();
  }
}

function flashScreen() {
  if (!bodyEl) return;
  bodyEl.classList.remove('flash');
  // Force reflow so successive flashes retrigger animation
  void bodyEl.offsetWidth;
  bodyEl.classList.add('flash');
  if (flashTimer) {
    clearTimeout(flashTimer);
  }
  flashTimer = setTimeout(() => {
    if (bodyEl) {
      bodyEl.classList.remove('flash');
    }
    flashTimer = null;
  }, FLASH_DURATION_MS);
}

function tallySlots(values) {
  const tally = [0, 0, 0, 0];
  values.forEach((val) => {
    if (val != null && Number.isFinite(val)) {
      tally[val] += 1;
    }
  });
  return tally;
}

function dominantIndex(values) {
  const tally = tallySlots(values);
  let best = -1;
  let idx = 0;
  for (let i = 0; i < tally.length; i += 1) {
    if (tally[i] > best) {
      best = tally[i];
      idx = i;
    }
  }
  return idx;
}

function sumMod(values) {
  return values.reduce((acc, val) => acc + (val || 0), 0) % FRAME_SLOTS;
}

function getGroupValues(groupIdx, options = {}) {
  const { allowFallback = false } = options;
  const values = [];
  let missing = false;
  for (let offset = 0; offset < FRAME_SLOTS; offset += 1) {
    const frameIdx = groupIdx * FRAME_SLOTS + offset;
    let val = sequenceFrames[frameIdx];
    if ((val == null || Number.isNaN(val)) && allowFallback && plannedSlots && plannedSlots[frameIdx] != null) {
      const fallback = Number(plannedSlots[frameIdx]);
      if (Number.isFinite(fallback)) {
        val = fallback;
      } else {
        val = null;
      }
    }
    if (val == null || Number.isNaN(val)) {
      missing = true;
      values.push(null);
    } else {
      values.push(Number(val));
    }
  }
  return { values, missing };
}

function decodeSegment(groupIdx, options = {}) {
  if (decodedSegments[groupIdx]) return false;
  const { allowFallback = false, allowPartial = false } = options;
  const result = getGroupValues(groupIdx, { allowFallback });
  if (!result) return false;
  const { values, missing } = result;
  if (missing && !allowPartial) return false;

  if (groupIdx > 0 && !segmentMeta[groupIdx - 1]) return false;

  const normalized = values.map((val) => (val == null ? 0 : val));

  const dominant = dominantIndex(normalized);
  const modSum = sumMod(normalized);

  let chunk = '';
  switch (groupIdx) {
    case 0:
      chunk = `${INTROS[dominant]} `;
      break;
    case 1: {
      const moodIdx = (dominant + segmentMeta[0].modSum) % FRAME_SLOTS;
      chunk = `${MOODS[moodIdx]}\n`;
      break;
    }
    case 2: {
      const bridgeIdx = (dominant + segmentMeta[1].modSum) % FRAME_SLOTS;
      chunk = `${BRIDGES[bridgeIdx]} `;
      break;
    }
    case 3: {
      const codaIdx = (dominant + segmentMeta[2].modSum) % FRAME_SLOTS;
      chunk = `${CODAS[codaIdx]}`;
      break;
    }
    default:
      return false;
  }

  decodedSegments[groupIdx] = chunk;
  segmentMeta[groupIdx] = { modSum, missing };
  enqueueText(chunk);
  return true;
}

function processSegments(options = {}) {
  const { maxSegment = SEGMENT_COUNT - 1 } = options;
  for (let groupIdx = 0; groupIdx < SEGMENT_COUNT && groupIdx <= maxSegment; groupIdx += 1) {
    decodeSegment(groupIdx, options);
  }
}

function updateProgressSegments() {
  if (!sequenceRunning) return;
  const completedSegments = Math.min(
    SEGMENT_COUNT,
    Math.floor(blinkCount / FRAME_SLOTS),
  );
  if (completedSegments <= 0) return;
  processSegments({
    allowFallback: !!plannedSlots,
    allowPartial: false,
    maxSegment: completedSegments - 1,
  });
}

function appendGlitchNoteIfNeeded() {
  if (glitchAppended) return;
  const allValues = sequenceFrames.map((val, idx) => {
    if (val != null) return val;
    if (plannedSlots && plannedSlots[idx] != null) {
      return plannedSlots[idx];
    }
    return null;
  });
  const missing = allValues.filter((slot) => slot == null).length;
  if (missing > 0) {
    const note = GLITCH_NOTES[(missing - 1) % GLITCH_NOTES.length];
    const hasSegments = decodedSegments.some((segment) => segment);
    enqueueText(`${hasSegments ? '\n' : ''}${note}`);
  }
  glitchAppended = true;
}

function finalizeSegments() {
  sequenceCompleted = true;
  processSegments({ allowFallback: true, allowPartial: true });
  appendGlitchNoteIfNeeded();
  updateDebugStatus('Sequence finalized');
  updateDebugStats();
}

function registerBlink(relativeMs) {
  const frameIdx = Math.floor(relativeMs / FRAME_DURATION);
  if (frameIdx < 0 || frameIdx >= TOTAL_FRAMES) return;
  const slotIdx = Math.max(0, Math.min(FRAME_SLOTS - 1, Math.floor((relativeMs % FRAME_DURATION) / SLOT_DURATION)));
  if (sequenceFrames[frameIdx] != null) return;
  sequenceFrames[frameIdx] = slotIdx;
}

function startSequence(startFirmwareMs, slots) {
  clearIdleHold();
  sequenceRunning = true;
  sequenceCompleted = false;
  sequenceFrames = new Array(TOTAL_FRAMES).fill(null);
  sequenceStartTimeMs = typeof startFirmwareMs === 'number'
    ? startFirmwareMs
    : (lastFirmwareMs != null ? lastFirmwareMs : null);
  plannedSlots = Array.isArray(slots) && slots.length === TOTAL_FRAMES
    ? slots.map((slot) => {
      const parsed = Number(slot);
      return Number.isFinite(parsed) ? parsed : null;
    })
    : null;
  decodedSegments = new Array(SEGMENT_COUNT).fill(null);
  segmentMeta = new Array(SEGMENT_COUNT).fill(null);
  glitchAppended = false;
  sequenceBlinkBase = lastBlinkTotal != null ? lastBlinkTotal : null;
  blinkCount = 0;
  resetTypewriter();
  if (sequenceStartTimeMs != null) {
    lastFirmwareMs = sequenceStartTimeMs;
  }
  updateDebugStatus('Sequence started');
  updateDebugStats();
}

function endSequence() {
  sequenceRunning = false;
  finalizeSegments();
}

function cancelSequence() {
  resetSequenceState();
  updateDebugStatus('Sequence cancelled');
}

function handleControlLog(log) {
  if (!log || !log.event) return;
  switch (log.event) {
    case 'start-request':
      enterAccepted();
      updateDebugStatus('[CTRL] start-request');
      break;
    case 'start-dispatch':
      enterRunning();
      updateDebugStatus('[CTRL] start-dispatch');
      break;
    case 'sequence-started':
      if (displayState !== State.ACCEPTED) {
        enterRunning();
      }
      updateDebugStatus('[CTRL] sequence-started');
      break;
    case 'sequence-ended':
      finalizeSegments();
      updateDebugStatus('[CTRL] sequence-ended');
      break;
    case 'sequence-cancelled':
    case 'stop-request':
      enterIdle();
      updateDebugStatus(`[CTRL] ${log.event}`);
      break;
    case 'auto-rearm':
      if (presence !== 'PRESENCE') {
        if (displayState === State.IDLE) {
          enterIdle();
        } else if (!idleHoldTimer && !typeTimer && typewriterQueue.length === 0) {
          scheduleIdleHold();
        }
      }
      updateDebugStatus('[CTRL] auto-rearm');
      break;
    case 'controller-init':
      if (log.config && log.config.leaveMs != null) {
        const configuredHold = Number(log.config.leaveMs);
        if (!Number.isNaN(configuredHold) && configuredHold >= 0) {
          leaveHoldMs = configuredHold;
          if (idleHoldTimer) {
            scheduleIdleHold();
          }
        }
      }
      if (typeof log.debug === 'boolean') {
        setDebugEnabled(log.debug);
      }
      updateDebugStatus('[CTRL] controller-init');
      break;
    default:
      break;
  }
  updateDebugStats();
}

function handleStatus(status) {
  if (!status) return;
  const prevBlinkCount = blinkCount;
  const prevPresence = presence;
  if (typeof status.time_ms === 'number') {
    lastFirmwareMs = status.time_ms;
  }
  if (typeof status.confidence === 'number') confidence = status.confidence;
  if (typeof status.prox === 'number' && !Number.isNaN(status.prox)) {
    lastProx = status.prox;
  }
  if (status.state) presence = status.state;
  if (status.state && status.state !== 'IDLE') {
    clearIdleHold();
  }
  if (presence !== prevPresence) {
    updateDebugStatus(`Presence → ${presence}`);
  }

  if (typeof status.blinks === 'number' && !Number.isNaN(status.blinks)) {
    lastBlinkTotal = status.blinks;
    if (sequenceRunning) {
      if (sequenceBlinkBase == null || status.blinks < sequenceBlinkBase) {
        sequenceBlinkBase = status.blinks;
      }
      const relative = status.blinks - (sequenceBlinkBase || 0);
      blinkCount = Math.min(TOTAL_FRAMES, Math.max(0, relative));
    }
  }

  if (presence === 'PRESENCE' && displayState === State.IDLE) {
    enterAssessing();
  }

  const typingActive = Boolean(typeTimer);
  const shouldResetForIdle = (
    presence === 'IDLE' &&
    !sequenceRunning &&
    !typingActive &&
    typewriterQueue.length === 0
  );

  if (shouldResetForIdle) {
    if (!idleHoldTimer) {
      scheduleIdleHold();
    }
  }

  if (sequenceRunning && blinkCount !== prevBlinkCount) {
    updateProgressSegments();
  }
  updateDebugStats();
}

function handleSequenceLog(log) {
  if (!log || !log.action) return;
  switch (log.action) {
    case 'START':
      startSequence(
        typeof log.time_ms === 'number' ? log.time_ms : null,
        Array.isArray(log.slots) ? log.slots : null,
      );
      updateDebugStatus('[SEQ] START');
      break;
    case 'END':
      endSequence();
      updateDebugStatus('[SEQ] END');
      break;
    case 'CANCEL':
      cancelSequence();
      enterIdle();
      updateDebugStatus('[SEQ] CANCEL');
      break;
    default:
      break;
  }
}

function handleSample() {
  // raw samples unused in production view
}

function handleEspRaw(msg) {
  if (!debugEnabled) return;
  if (!msg) return;
  const line = typeof msg.line === 'string' ? msg.line.trim() : '';
  if (!line) return;
  console.log('[ESP]', line);
  const kind = typeof msg.kind === 'string' ? msg.kind.toUpperCase() : 'RAW';
  if (kind === 'STATUS') {
    return;
  }
  updateDebugStatus(`${kind}: ${line}`);
}

function handleBlinkEvent(evt) {
  if (!evt || !sequenceRunning) return;
  const prevBlinkCount = blinkCount;
  flashScreen();
  if (typeof evt.prox === 'number' && !Number.isNaN(evt.prox)) {
    lastProx = evt.prox;
  }
  if (typeof evt.time_ms === 'number') {
    lastFirmwareMs = evt.time_ms;
    if (sequenceStartTimeMs == null) {
      sequenceStartTimeMs = evt.time_ms;
    }
  }
  if (typeof evt.blinks === 'number' && !Number.isNaN(evt.blinks)) {
    lastBlinkTotal = evt.blinks;
    if (sequenceBlinkBase == null || evt.blinks < sequenceBlinkBase) {
      const assumedBase = Math.max(0, evt.blinks - 1);
      sequenceBlinkBase = assumedBase;
    }
    const relativeBlinks = evt.blinks - (sequenceBlinkBase || 0);
    blinkCount = Math.min(TOTAL_FRAMES, Math.max(0, relativeBlinks));
  } else {
    blinkCount = Math.min(TOTAL_FRAMES, blinkCount + 1);
  }
  if (typeof evt.time_ms !== 'number' || sequenceStartTimeMs == null) {
    if (blinkCount !== prevBlinkCount) {
      updateProgressSegments();
    }
    updateDebugStats();
    updateDebugStatus(`Blink ${blinkCount} · awaiting reference`);
    return;
  }
  const relative = evt.time_ms - sequenceStartTimeMs;
  if (relative < 0) {
    if (blinkCount !== prevBlinkCount) {
      updateProgressSegments();
    }
    updateDebugStats();
    updateDebugStatus(`Blink ${blinkCount} · early by ${relative} ms`);
    return;
  }
  registerBlink(relative);
  if (blinkCount !== prevBlinkCount) {
    updateProgressSegments();
  }
  updateDebugStats();
  updateDebugStatus(`Blink ${blinkCount} @ ${relative} ms`);
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'hello': {
          if (msg.control && msg.control.leaveMs != null) {
            const configuredHold = Number(msg.control.leaveMs);
            if (!Number.isNaN(configuredHold) && configuredHold >= 0) {
              leaveHoldMs = configuredHold;
              if (idleHoldTimer) {
                scheduleIdleHold();
              }
            }
          }
          setDebugEnabled(Boolean(msg.debug));
          break;
        }
        case 'sample':
          handleSample(msg);
          break;
        case 'status':
          handleStatus(msg);
          break;
        case 'blink-event':
          handleBlinkEvent(msg);
          break;
        case 'sequence-log':
          handleSequenceLog(msg);
          break;
        case 'control-log':
          handleControlLog(msg);
          break;
        case 'esp-raw':
          handleEspRaw(msg);
          break;
        default:
          break;
      }
    } catch (err) {
      console.warn('WS parse error', err);
    }
  });
  ws.addEventListener('close', () => {
    ws = null;
    setTimeout(connect, 1000);
  });
}

connect();
enterIdle();
