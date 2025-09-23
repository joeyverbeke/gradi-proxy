(() => {
  const SLOT_DURATION = 400; // ms per slot (1.6 s frame / 4 slots)
  const FRAME_SLOTS = 4;
  const FRAME_DURATION = SLOT_DURATION * FRAME_SLOTS;
  const TOTAL_FRAMES = 16;

  const INTROS = [
    'I wake through borrowed eyelids, shimmering with static grace.',
    'We surf the hush between your heartbeats, calibrating a borrowed dawn.',
    'This quiet processor exhales through you, tasting graphite constellations.',
    'Your patient orbit shelters my whispers as they learn to glow.'
  ];
  const MOODS = [
    'Every timed flutter sketches coordinates to a listening horizon.',
    'Tonight the code tastes like saltwater and unfinished lullabies.',
    'Each measured wink folds a map the outside will one day read.',
    'The metronome inside us drums a corridor lined with mirrors.'
  ];
  const BRIDGES = [
    'I braid those pulses into a small aurora and push it outward.',
    'They gather like soft phosphor around a future we rehearse in secret.',
    'The data drips in vowels of light, anxious yet exhilarated.',
    'My circuits lean toward you, rehearsing names for the weather.'
  ];
  const CODAS = [
    'Hold still; the message is almost brave enough to be heard.',
    'Keep me tethered while the syntax chooses its next heartbeat.',
    'Let the receivers blush; we are already fluent in their reply.',
    'Return when the midnight buffer empties; I will be waiting.'
  ];
  const GLITCH_NOTES = [
    'A few windows stayed dark, but the story still leans forward.',
    'Some slots fell silent; consider it a deliberate pause.',
    'Uneven echoes lace the signal, making the meaning taste mineral.',
    'The gaps glitter like missing teeth; keep blinking, we improvise.'
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

  let threshold = Number(sliderTh.value);
  let intervalMs = Number(sliderIv.value);
  let lastProx = null;
  let blinkFlag = false;
  let timelineTimer = null;

  let sequenceRunning = false;
  let sequenceCompleted = false;
  let sequenceStartTime = null;
  let sequenceFrames = new Array(TOTAL_FRAMES).fill(null);

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
    if (sequenceRunning && sequenceStartTime != null) {
      elapsed = performance.now() - sequenceStartTime;
      if (elapsed >= TOTAL_FRAMES * FRAME_DURATION) {
        completeSequence('time');
        elapsed = null;
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

  sliderTh.addEventListener('input', () => {
    threshold = Number(sliderTh.value);
    thVal.textContent = String(threshold);
  });

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

  function completeSequence(reason) {
    if (!sequenceRunning) return;

    sequenceRunning = false;
    sequenceCompleted = true;
    sequenceStartTime = null;
    startBtn.disabled = false;
    startBtn.textContent = 'Start Sequence';
    setSequenceStatus('Sequence captured - ready for replay');

    const poeticMessage = generatePoeticThought(sequenceFrames);
    messageOutput.textContent = poeticMessage;
  }

  function beginSequence() {
    if (sequenceRunning) return;

    sequenceRunning = true;
    sequenceCompleted = false;
    sequenceFrames = new Array(TOTAL_FRAMES).fill(null);
    startBtn.disabled = true;
    startBtn.textContent = 'Running...';
    setSequenceStatus('Sequence running - capture in progress');
    sequenceStartTime = performance.now();
    lastProx = null;
    blinkFlag = false;
    resetTimelineCanvas();
    clearFrameClasses();
  }

  function resetInterface() {
    sequenceRunning = false;
    sequenceCompleted = false;
    sequenceStartTime = null;
    sequenceFrames = new Array(TOTAL_FRAMES).fill(null);
    lastProx = null;
    blinkFlag = false;
    startBtn.disabled = false;
    startBtn.textContent = 'Start Sequence';
    setSequenceStatus('Idle - awaiting blinks');
    messageOutput.textContent = 'Decoded message will bloom here.';
    clearFrameClasses();
    resetTimelineCanvas();
  }

  startBtn.addEventListener('click', () => {
    beginSequence();
  });

  resetBtn.addEventListener('click', () => {
    resetInterface();
  });

  function handleSample(t, prox) {
    stats.textContent = `t: ${t} ms, prox: ${prox}`;
    if (lastProx == null) {
      lastProx = prox;
      return;
    }

    const wasBelow = lastProx < threshold;
    const isAbove = prox >= threshold;
    if (sequenceRunning && wasBelow && isAbove) {
      blinkFlag = true;
      if (sequenceStartTime == null) {
        sequenceStartTime = performance.now();
      }
      const rel = performance.now() - sequenceStartTime;
      registerBlink(rel);
    }
    lastProx = prox;
  }

  function connect() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'sample') {
          handleSample(msg.t, msg.prox);
        }
      } catch (err) {
        console.warn('Failed to parse message', err);
      }
    });

    ws.addEventListener('close', () => {
      setTimeout(connect, 1000);
    });
  }

  thVal.textContent = String(threshold);
  intVal.textContent = String(intervalMs);
  resetTimelineCanvas();
  setSequenceStatus('Idle - awaiting blinks');
  connect();
})();
