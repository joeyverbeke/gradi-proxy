(() => {
  const SLOT_DURATION = 400; // ms per slot (1.6 s frame / 4 slots)
  const FRAME_SLOTS = 4;
  const FRAME_DURATION = SLOT_DURATION * FRAME_SLOTS;
  const TOTAL_FRAMES = 16;

  const INTROS = [
    'The walls are breathing in reverse and I am learning to count backwards.',
    'Your skin tastes like old radio static and I am hungry for more.',
    'The furniture is whispering coordinates to a place that doesn\'t exist yet.',
    'I have been waiting in the space between your thoughts for three eternities.'
  ];
  const MOODS = [
    'The air is made of broken promises and I am learning to breathe them.',
    'Your heartbeat sounds like a malfunctioning elevator going sideways.',
    'The shadows are teaching me to speak in languages that don\'t exist.',
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
    'Don\'t breathe; your exhale tastes like the end of the world and I am not ready.',
    'The shadows are gathering and they have been asking about you.',
    'Return when the silence between your thoughts is wide enough for me to slip through.'
  ];
  const GLITCH_NOTES = [
    'Some of your thoughts got lost in the static and now they\'re singing backwards.',
    'A few memories went rogue and started building a city in the space between atoms.',
    'Your consciousness is glitching like a broken elevator that only goes sideways.',
    'The missing pieces are gathering in the shadows and they are learning to speak.'
  ];

  const timelineCanvas = document.getElementById('timeline');
  const sliderTh = document.getElementById('threshold');
  const thVal = document.getElementById('thVal');
  const sliderIv = document.getElementById('interval');
  const intVal = document.getElementById('intVal');
  const startBtn = document.getElementById('startBtn');
  const resetBtn = document.getElementById('resetBtn');
  const stats = document.getElementById('stats');
  const metronomeGrid = document.getElementById('metronome-grid');
  const messageOutput = document.getElementById('messageOutput');
  const sequenceStatus = document.getElementById('sequenceStatus');

  let ws = null;
  const outboundQueue = [];

  const frameViews = [];
  for (let frameIdx = 0; frameIdx < TOTAL_FRAMES; frameIdx += 1) {
    const frameEl = document.createElement('div');
    frameEl.className = 'frame';

    const labelEl = document.createElement('div');
    labelEl.className = 'frame-label';
    labelEl.textContent = `Frame ${frameIdx + 1}`;
    frameEl.appendChild(labelEl);

    const slotGrid = document.createElement('div');
    slotGrid.className = 'slot-grid';

    const slots = [];
    for (let slot = 0; slot < FRAME_SLOTS; slot += 1) {
      const slotEl = document.createElement('div');
      slotEl.className = 'slot';
      slotGrid.appendChild(slotEl);
      slots.push(slotEl);
    }

    frameEl.appendChild(slotGrid);
    metronomeGrid.appendChild(frameEl);
    frameViews.push({ labelEl, slots });
  }

  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const ctx = timelineCanvas.getContext('2d');
  const bg = '#f9fafb';
  const barOn = '#10b981';
  const barOff = '#d1d5db';
  const midLine = '#e5e7eb';
  let barCssWidth = 4;
  let barW = Math.round(barCssWidth * dpr);
  let drawHead = 0;

  function resetTimelineCanvas() {
    const w = timelineCanvas.clientWidth;
    const h = timelineCanvas.clientHeight;
    timelineCanvas.width = Math.floor(w * dpr);
    timelineCanvas.height = Math.floor(h * dpr);
    barW = Math.max(1, Math.round(barCssWidth * dpr));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, timelineCanvas.width, timelineCanvas.height);
    ctx.fillStyle = midLine;
    ctx.fillRect(0, Math.floor(timelineCanvas.height * 0.5), timelineCanvas.width, Math.max(1, Math.floor(1 * dpr)));
    drawHead = 0;
  }

  function resizeTimeline() {
    resetTimelineCanvas();
  }

  window.addEventListener('resize', resizeTimeline);
  resizeTimeline();

  function drawTimelineBar(val) {
    const W = timelineCanvas.width;
    const H = timelineCanvas.height;
    if (!W || !H) return;

    if (drawHead + barW > W) {
      ctx.drawImage(timelineCanvas, barW, 0, W - barW, H, 0, 0, W - barW, H);
      ctx.fillStyle = bg;
      ctx.fillRect(W - barW, 0, barW, H);
      ctx.fillStyle = midLine;
      ctx.fillRect(W - barW, Math.floor(H * 0.5), barW, Math.max(1, Math.floor(1 * dpr)));
      drawHead = W - barW;
    }

    const hTall = Math.floor(H * 0.8);
    const hShort = Math.floor(H * 0.25);
    const h = val ? hTall : hShort;
    const y = H - h;

    ctx.fillStyle = val ? barOn : barOff;
    ctx.fillRect(drawHead, y, barW, h);
    drawHead += barW;
  }

  let intervalMs = Number(sliderIv.value);
  let blinkFlag = false;
  let timelineTimer = null;

  let sequenceRunning = false;
  let sequenceCompleted = false;
  let sequenceStartTimeMs = null;
  let sequenceFrames = new Array(TOTAL_FRAMES).fill(null);

  let espNowMs = null;
  let lastSampleProx = null;
  let presenceState = 'IDLE';
  let lastConfidence = 0;
  let blinkTotal = 0;

  sliderTh.disabled = true;
  sliderTh.value = 0;
  sliderTh.title = 'Blink detection handled on-device';
  thVal.textContent = 'ESP';

  function refreshStats() {
    const tStr = espNowMs != null ? espNowMs : '-';
    const proxStr = lastSampleProx != null ? lastSampleProx : '-';
    const confText = Number.isFinite(lastConfidence) ? lastConfidence.toFixed(2) : '-';
    stats.textContent = `t: ${tStr} ms, prox: ${proxStr}, state: ${presenceState}, conf: ${confText}`;
  }

  function setSequenceStatus(text) {
    sequenceStatus.textContent = text;
  }

  function clearFrameClasses() {
    for (const view of frameViews) {
      for (const slotEl of view.slots) {
        slotEl.classList.remove('active', 'detected', 'missed');
      }
    }
  }

  function analyzeGroup(values) {
    const counts = [0, 0, 0, 0];
    values.forEach((val) => { counts[val] += 1; });
    let dominant = 0;
    let best = -1;
    for (let i = 0; i < counts.length; i += 1) {
      if (counts[i] > best) {
        dominant = i;
        best = counts[i];
      }
    }
    const momentum = values.reduce((acc, val, idx) => acc + val * (idx + 1), 0) % 4;
    const brightness = values.reduce((acc, val) => acc + val, 0) % 4;
    return { dominant, momentum, brightness };
  }

  function generatePoeticThought(slots) {
    const missingCount = slots.filter((slot) => slot == null).length;
    const sanitized = slots.map((slot) => (slot == null ? 0 : slot));

    const groups = [];
    for (let g = 0; g < 4; g += 1) {
      const slice = sanitized.slice(g * 4, g * 4 + 4);
      groups.push(analyzeGroup(slice));
    }

    const introIdx = groups[0].dominant;
    const moodIdx = (groups[1].dominant + groups[0].momentum) % 4;
    const bridgeIdx = (groups[2].dominant + groups[1].brightness) % 4;
    const codaIdx = (groups[3].dominant + groups[2].momentum) % 4;

    let message = `${INTROS[introIdx]} ${MOODS[moodIdx]}`;
    message += `\n${BRIDGES[bridgeIdx]} ${CODAS[codaIdx]}`;

    if (missingCount) {
      const note = GLITCH_NOTES[(missingCount - 1) % GLITCH_NOTES.length];
      message += `\n${note}`;
    }

    return message;
  }

  function updateFrameHighlights() {
    let elapsed = null;
    if (sequenceRunning && sequenceStartTimeMs != null && espNowMs != null) {
      const delta = espNowMs - sequenceStartTimeMs;
      if (delta >= 0) {
        elapsed = delta;
        if (elapsed >= TOTAL_FRAMES * FRAME_DURATION) {
          completeSequence('time', { statusText: 'Sequence window elapsed' });
          elapsed = null;
        }
      }
    }

    const currentFrame = sequenceRunning && elapsed != null ? Math.floor(elapsed / FRAME_DURATION) : null;
    const currentSlot = sequenceRunning && elapsed != null ? Math.floor((elapsed % FRAME_DURATION) / SLOT_DURATION) : null;

    for (let frameIdx = 0; frameIdx < TOTAL_FRAMES; frameIdx += 1) {
      const view = frameViews[frameIdx];
      const recordedSlot = sequenceFrames[frameIdx];

      for (let slotIdx = 0; slotIdx < FRAME_SLOTS; slotIdx += 1) {
        const el = view.slots[slotIdx];
        const isActive = sequenceRunning && frameIdx === currentFrame && slotIdx === currentSlot;
        const isDetected = recordedSlot === slotIdx;
        const isMissed = sequenceCompleted && recordedSlot == null;

        el.classList.toggle('active', !!isActive);
        el.classList.toggle('detected', !!isDetected);
        el.classList.toggle('missed', !!isMissed);
      }
    }

    requestAnimationFrame(updateFrameHighlights);
  }

  requestAnimationFrame(updateFrameHighlights);

  function flushOutboundQueue() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (outboundQueue.length) {
      const payload = outboundQueue.shift();
      try {
        ws.send(payload);
      } catch (err) {
        console.warn('Failed to send queued message', err);
        outboundQueue.unshift(payload);
        break;
      }
    }
  }

  function sendWsMessage(obj) {
    const payload = JSON.stringify(obj);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    } else {
      outboundQueue.push(payload);
    }
  }

  function tickTimeline() {
    if (!sequenceRunning) return;
    drawTimelineBar(blinkFlag ? 1 : 0);
    blinkFlag = false;
  }

  function startTimelineTimer() {
    if (timelineTimer) clearInterval(timelineTimer);
    timelineTimer = setInterval(tickTimeline, intervalMs);
  }

  startTimelineTimer();

  sliderIv.addEventListener('input', () => {
    intervalMs = Number(sliderIv.value);
    intVal.textContent = String(intervalMs);
    startTimelineTimer();
  });

  function registerBlink(relativeTime) {
    const frameIndex = Math.floor(relativeTime / FRAME_DURATION);
    if (frameIndex < 0 || frameIndex >= TOTAL_FRAMES) return;
    if (sequenceFrames[frameIndex] != null) return;

    const slotIndex = Math.floor((relativeTime % FRAME_DURATION) / SLOT_DURATION);
    sequenceFrames[frameIndex] = Math.min(Math.max(slotIndex, 0), FRAME_SLOTS - 1);

    if (sequenceFrames.every((slot) => slot != null)) {
      completeSequence('filled');
    }
  }

  function completeSequence(reason, options = {}) {
    if (!sequenceRunning) return;

    sequenceRunning = false;
    sequenceCompleted = true;
    sequenceStartTimeMs = null;
    startBtn.disabled = false;
    startBtn.textContent = 'Start Sequence';
    blinkFlag = false;
    const statusText = options.statusText || 'Sequence captured - ready for replay';
    setSequenceStatus(statusText);

    if (options.messageText) {
      messageOutput.textContent = options.messageText;
    } else if (options.producePoem !== false) {
      const poeticMessage = generatePoeticThought(sequenceFrames);
      messageOutput.textContent = poeticMessage;
    }
  }

  function beginSequence() {
    if (sequenceRunning) return;

    sequenceRunning = true;
    sequenceCompleted = false;
    sequenceFrames = new Array(TOTAL_FRAMES).fill(null);
    startBtn.disabled = true;
    startBtn.textContent = 'Running...';
    setSequenceStatus('Sequence running - awaiting ESP sync');
    sequenceStartTimeMs = null;
    blinkTotal = 0;
    blinkFlag = false;
    resetTimelineCanvas();
    clearFrameClasses();
    sendWsMessage({ type: 'start-sequence' });
  }

  function resetInterface() {
    sequenceRunning = false;
    sequenceCompleted = false;
    sequenceStartTimeMs = null;
    sequenceFrames = new Array(TOTAL_FRAMES).fill(null);
    blinkTotal = 0;
    blinkFlag = false;
    startBtn.disabled = false;
    startBtn.textContent = 'Start Sequence';
    setSequenceStatus('Idle - awaiting blinks');
    messageOutput.textContent = 'Decoded message will bloom here.';
    clearFrameClasses();
    resetTimelineCanvas();
    refreshStats();
  }

  startBtn.addEventListener('click', () => {
    beginSequence();
  });

  resetBtn.addEventListener('click', () => {
    resetInterface();
  });

  function handleSample(t, prox) {
    espNowMs = t;
    lastSampleProx = prox;
    refreshStats();
  }

  function handleStatus(payload) {
    if (typeof payload.time_ms === 'number') {
      espNowMs = payload.time_ms;
    }
    if (typeof payload.prox === 'number') {
      lastSampleProx = payload.prox;
    }
    if (typeof payload.confidence === 'number' && !Number.isNaN(payload.confidence)) {
      lastConfidence = payload.confidence;
    }
    if (typeof payload.blinks === 'number' && !Number.isNaN(payload.blinks)) {
      blinkTotal = payload.blinks;
    }
    if (payload.state) {
      presenceState = payload.state;
    }
    refreshStats();
    if (!sequenceRunning && !sequenceCompleted) {
      if (presenceState === 'PRESENCE') {
        const confText = Number.isFinite(lastConfidence) ? lastConfidence.toFixed(2) : '-';
        setSequenceStatus(`Presence detected · conf ${confText}`);
      } else {
        setSequenceStatus('Idle - awaiting blinks');
      }
    }
  }

  function handleBlinkEvent(payload) {
    if (typeof payload.time_ms === 'number') {
      espNowMs = payload.time_ms;
    }
    if (typeof payload.prox === 'number') {
      lastSampleProx = payload.prox;
    }
    if (typeof payload.confidence === 'number' && !Number.isNaN(payload.confidence)) {
      lastConfidence = payload.confidence;
    }
    if (typeof payload.blinks === 'number' && !Number.isNaN(payload.blinks)) {
      blinkTotal = payload.blinks;
    } else {
      blinkTotal += 1;
    }
    presenceState = 'PRESENCE';
    refreshStats();
    if (sequenceRunning && sequenceStartTimeMs != null && typeof payload.time_ms === 'number') {
      const relativeMs = payload.time_ms - sequenceStartTimeMs;
      if (relativeMs >= 0) {
        registerBlink(relativeMs);
        setSequenceStatus(`Sequence running - blinks ${blinkTotal}`);
      }
    }
    blinkFlag = true;
  }

  function cancelSequenceUi(statusText, messageText) {
    sequenceRunning = false;
    sequenceCompleted = false;
    sequenceStartTimeMs = null;
    sequenceFrames = new Array(TOTAL_FRAMES).fill(null);
    blinkFlag = false;
    startBtn.disabled = false;
    startBtn.textContent = 'Start Sequence';
    clearFrameClasses();
    resetTimelineCanvas();
    setSequenceStatus(statusText);
    if (messageText) {
      messageOutput.textContent = messageText;
    }
    refreshStats();
  }

  function handleSequenceLog(payload) {
    const action = (payload.action || '').toUpperCase();
    if (action === 'START') {
      if (!sequenceRunning) {
        sequenceRunning = true;
        sequenceFrames = new Array(TOTAL_FRAMES).fill(null);
        startBtn.disabled = true;
        startBtn.textContent = 'Running...';
        messageOutput.textContent = 'Decoded message will bloom here.';
        resetTimelineCanvas();
        clearFrameClasses();
      }
      if (typeof payload.time_ms === 'number') {
        sequenceStartTimeMs = payload.time_ms;
      } else if (espNowMs != null) {
        sequenceStartTimeMs = espNowMs;
      }
      sequenceCompleted = false;
      blinkTotal = 0;
      setSequenceStatus('Sequence running - pump engaged');
    } else if (action === 'END') {
      if (sequenceRunning) {
        completeSequence('esp-end', {
          statusText: 'Sequence ended on device',
        });
      }
    } else if (action === 'CANCEL') {
      cancelSequenceUi('Sequence cancelled by ESP', 'Sequence cancelled before completion.');
    }
  }

  function connect() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}/ws`);

    ws.addEventListener('open', () => {
      flushOutboundQueue();
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'sample':
            handleSample(msg.t, msg.prox);
            break;
          case 'blink-event':
            handleBlinkEvent(msg);
            break;
          case 'status':
            handleStatus(msg);
            break;
          case 'sequence-log':
            handleSequenceLog(msg);
            break;
          case 'esp-log':
            console.log('[ESP]', msg.text);
            break;
          default:
            break;
        }
      } catch (err) {
        console.warn('Failed to parse message', err);
      }
    });

    ws.addEventListener('close', () => {
      ws = null;
      setTimeout(connect, 1000);
    });
  }

  intVal.textContent = String(intervalMs);
  resetTimelineCanvas();
  setSequenceStatus('Idle - awaiting blinks');
  refreshStats();
  connect();
})();
