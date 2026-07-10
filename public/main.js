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
const NO_BLINK_SLOT = -1;
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
let framesResolved = 0;

const INTROS = [
  'A thought arrives, still cold from the journey.',
  'The air in the room is older than the walls.',
  "The concept of 'north' feels different today, less certain.",
  'The light from the window is not a memory, but it feels like one.'
];
const MOODS = [
  'The silence in the room is heavy, and colder near the floor.',
  'A faint scent of rust, from a question left unanswered.',
  'There is a fifth direction, but it has no name.',
  'The sound of thirst is coming from the word \'water\'.'
];
const BRIDGES = [
  'An echo is the ghost of a sound, and it has begun to haunt the light.',
  'It is raining in the space between thoughts.',
  'A word passes from one language to another, leaving a small, warm wake.',
  'The horizon is not a line, but a slow, approaching sound.'
];
const CODAS = [
  'The thought is yours again, but it has been folded differently.',
  'The fifth direction has withdrawn. The four remain.',
  'The unanswered question has evaporated, leaving only the rust.',
  'The echo has settled back into the sound. The light is alone again.'
];
const GLITCH_NOTES = [
  'The memory of warmth arrived before the feeling of cold left.',
  'The word for \'silence\' made a brief, almost inaudible sound.',
  'The echo of the light was a different color.',
  'For a moment, the horizon inverted itself.'
];

// Widest line drives the size: start at the cap and shrink to fit the column
// so no phrase ever wraps onto a second line.
const MESSAGE_MAX_FONT_PX = 1.6 * 16; // matches the 1.6rem cap in the CSS
function fitMessageText() {
  if (!messageEl) return;
  messageEl.style.fontSize = `${MESSAGE_MAX_FONT_PX}px`;
  if (messageEl.scrollWidth > messageEl.clientWidth) {
    const scaled = MESSAGE_MAX_FONT_PX * (messageEl.clientWidth / messageEl.scrollWidth);
    messageEl.style.fontSize = `${Math.floor(scaled * 100) / 100}px`;
  }
}

function setMessage(text) {
  messageEl.textContent = text;
  if (text) {
    messageEl.classList.add('visible');
  } else {
    messageEl.classList.remove('visible');
  }
  fitMessageText();
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
  framesResolved = 0;
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
  const wasDisplaying = displayState === State.DISPLAYING;
  const baseChunk = typewriterQueue.shift() || '';
  const needsLineBreak = wasDisplaying &&
    messageEl &&
    messageEl.textContent &&
    !messageEl.textContent.endsWith('\n');
  currentChunk = `${needsLineBreak ? '\n' : ''}${baseChunk}`;
  currentChunkIndex = 0;
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
    fitMessageText();
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
    if (val != null && Number.isFinite(val) && val >= 0) {
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
  return values.reduce((acc, val) => {
    if (val == null || !Number.isFinite(val) || val < 0) {
      return acc;
    }
    return acc + val;
  }, 0) % FRAME_SLOTS;
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

  const actualValues = values.filter((val) => val != null && val >= 0);
  const hasBlinkData = actualValues.length > 0;
  const dominant = hasBlinkData ? dominantIndex(actualValues) : Math.floor(Math.random() * FRAME_SLOTS);
  const modSum = hasBlinkData ? sumMod(actualValues) : Math.floor(Math.random() * FRAME_SLOTS);

  let englishChunk = '';
  switch (groupIdx) {
    case 0: {
      englishChunk = `${INTROS[dominant]} `;
      break;
    }
    case 1: {
      const moodIdx = (dominant + segmentMeta[0].modSum) % FRAME_SLOTS;
      englishChunk = `${MOODS[moodIdx]}\n`;
      break;
    }
    case 2: {
      const bridgeIdx = (dominant + segmentMeta[1].modSum) % FRAME_SLOTS;
      englishChunk = `${BRIDGES[bridgeIdx]} `;
      break;
    }
    case 3: {
      const codaIdx = (dominant + segmentMeta[2].modSum) % FRAME_SLOTS;
      englishChunk = `${CODAS[codaIdx]}`;
      break;
    }
    default:
      return false;
  }

  decodedSegments[groupIdx] = englishChunk;
  segmentMeta[groupIdx] = { modSum, missing };
  enqueueText(englishChunk);
  return true;
}

function processSegments(options = {}) {
  const { maxSegment = SEGMENT_COUNT - 1 } = options;
  for (let groupIdx = 0; groupIdx < SEGMENT_COUNT && groupIdx <= maxSegment; groupIdx += 1) {
    decodeSegment(groupIdx, options);
  }
}

function updateProgressSegments() {
  const resolvedFrames = Math.min(TOTAL_FRAMES, framesResolved);
  if (resolvedFrames <= 0) return;
  const completedSegments = Math.min(
    SEGMENT_COUNT,
    Math.floor(resolvedFrames / FRAME_SLOTS),
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
    const idx = (missing - 1) % GLITCH_NOTES.length;
    const note = GLITCH_NOTES[idx];
    const hasSegments = decodedSegments.some((segment) => segment);
    const prefix = hasSegments ? '\n' : '';
    enqueueText(`${prefix}${note}`);
  }
  glitchAppended = true;
}

function finalizeSegments() {
  sequenceCompleted = true;
  resolveAllFrames();
  processSegments({ allowFallback: true, allowPartial: true });
  appendGlitchNoteIfNeeded();
  updateDebugStatus('Sequence finalized');
  updateDebugStats();
}

function registerBlink(relativeMs) {
  const frameIdx = Math.floor(relativeMs / FRAME_DURATION);
  if (frameIdx < 0 || frameIdx >= TOTAL_FRAMES) return;
  const slotIdx = Math.max(0, Math.min(FRAME_SLOTS - 1, Math.floor((relativeMs % FRAME_DURATION) / SLOT_DURATION)));
  if (sequenceFrames[frameIdx] != null && sequenceFrames[frameIdx] !== NO_BLINK_SLOT) return;
  sequenceFrames[frameIdx] = slotIdx;
}

function resolveFramesThrough(firmwareMs) {
  if (!sequenceRunning) return;
  if (typeof firmwareMs !== 'number' || Number.isNaN(firmwareMs)) return;
  if (sequenceStartTimeMs == null) {
    sequenceStartTimeMs = firmwareMs;
  }
  const relative = firmwareMs - sequenceStartTimeMs;
  if (!Number.isFinite(relative) || relative < 0) return;
  const completedFrames = Math.min(TOTAL_FRAMES, Math.floor(relative / FRAME_DURATION));
  if (completedFrames <= framesResolved) return;
  for (let frameIdx = framesResolved; frameIdx < completedFrames; frameIdx += 1) {
    if (sequenceFrames[frameIdx] == null) {
      sequenceFrames[frameIdx] = NO_BLINK_SLOT;
    }
  }
  framesResolved = completedFrames;
  updateProgressSegments();
}

function resolveAllFrames() {
  for (let frameIdx = 0; frameIdx < TOTAL_FRAMES; frameIdx += 1) {
    if (sequenceFrames[frameIdx] == null) {
      sequenceFrames[frameIdx] = NO_BLINK_SLOT;
    }
  }
  framesResolved = TOTAL_FRAMES;
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
  framesResolved = 0;
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
    resolveFramesThrough(status.time_ms);
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
      if (typeof log.time_ms === 'number') {
        resolveFramesThrough(log.time_ms);
      }
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
    resolveFramesThrough(evt.time_ms);
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
          if (bodyEl) {
            bodyEl.classList.toggle('kiosk-mode', Boolean(msg.fullscreen));
          }
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

window.addEventListener('resize', fitMessageText);

connect();
enterIdle();
