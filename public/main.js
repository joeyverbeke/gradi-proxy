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

const messageEl = document.getElementById('message');
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
}

function enterIdle() {
  stopEllipsis();
  stopTypewriter();
  displayState = State.IDLE;
  setMessage('');
  resetSequenceState();
}

function enterAssessing() {
  if (displayState === State.ASSESSING) return;
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
}

function enterAccepted() {
  if (displayState === State.ACCEPTED) return;
  stopEllipsis();
  stopTypewriter();
  displayState = State.ACCEPTED;
  setMessage('host accepted.');
}

function enterRunning() {
  if (displayState === State.RUNNING) return;
  stopEllipsis();
  resetTypewriter();
  displayState = State.RUNNING;
  setMessage('');
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
  typewriterQueue.push(text);
  if (!typeTimer) {
    startNextChunk();
  }
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
  let usedFallback = false;
  for (let offset = 0; offset < FRAME_SLOTS; offset += 1) {
    const frameIdx = groupIdx * FRAME_SLOTS + offset;
    let val = sequenceFrames[frameIdx];
    if ((val == null || Number.isNaN(val)) && allowFallback && plannedSlots && plannedSlots[frameIdx] != null) {
      const fallback = Number(plannedSlots[frameIdx]);
      if (Number.isFinite(fallback)) {
        val = fallback;
        usedFallback = true;
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
  return { values, missing, usedFallback };
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
}

function registerBlink(relativeMs) {
  const frameIdx = Math.floor(relativeMs / FRAME_DURATION);
  if (frameIdx < 0 || frameIdx >= TOTAL_FRAMES) return;
  const slotIdx = Math.max(0, Math.min(FRAME_SLOTS - 1, Math.floor((relativeMs % FRAME_DURATION) / SLOT_DURATION)));
  if (sequenceFrames[frameIdx] != null) return;
  sequenceFrames[frameIdx] = slotIdx;
}

function startSequence(startFirmwareMs, slots) {
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
}

function endSequence() {
  sequenceRunning = false;
  finalizeSegments();
}

function cancelSequence() {
  resetSequenceState();
}

function handleControlLog(log) {
  if (!log || !log.event) return;
  switch (log.event) {
    case 'start-request':
      enterAccepted();
      break;
    case 'start-dispatch':
      enterRunning();
      break;
    case 'sequence-started':
      if (displayState !== State.ACCEPTED) {
        enterRunning();
      }
      break;
    case 'sequence-ended':
      finalizeSegments();
      break;
    case 'sequence-cancelled':
    case 'stop-request':
      enterIdle();
      break;
    case 'auto-rearm':
      if (presence !== 'PRESENCE') {
        enterIdle();
      }
      break;
    default:
      break;
  }
}

function handleStatus(status) {
  if (!status) return;
  const prevBlinkCount = blinkCount;
  if (typeof status.time_ms === 'number') {
    lastFirmwareMs = status.time_ms;
  }
  if (typeof status.confidence === 'number') confidence = status.confidence;
  if (status.state) presence = status.state;

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

  if (presence === 'IDLE') {
    enterIdle();
  }

  if (sequenceRunning && blinkCount !== prevBlinkCount) {
    updateProgressSegments();
  }
}

function handleSequenceLog(log) {
  if (!log || !log.action) return;
  switch (log.action) {
    case 'START':
      startSequence(
        typeof log.time_ms === 'number' ? log.time_ms : null,
        Array.isArray(log.slots) ? log.slots : null,
      );
      break;
    case 'END':
      endSequence();
      break;
    case 'CANCEL':
      cancelSequence();
      enterIdle();
      break;
    default:
      break;
  }
}

function handleSample() {
  // raw samples unused in production view
}

function handleBlinkEvent(evt) {
  if (!evt || !sequenceRunning) return;
  const prevBlinkCount = blinkCount;
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
    return;
  }
  const relative = evt.time_ms - sequenceStartTimeMs;
  if (relative < 0) {
    if (blinkCount !== prevBlinkCount) {
      updateProgressSegments();
    }
    return;
  }
  registerBlink(relative);
  if (blinkCount !== prevBlinkCount) {
    updateProgressSegments();
  }
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
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
