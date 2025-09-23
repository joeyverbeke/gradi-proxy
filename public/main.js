(() => {
  // Elements
  const canvasEl = document.getElementById('canvas');
  const sliderTh = document.getElementById('threshold');
  const thVal    = document.getElementById('thVal');
  const sliderIv = document.getElementById('interval');
  const intVal   = document.getElementById('intVal');
  const stats    = document.getElementById('stats');

  // State
  let threshold = Number(sliderTh.value);
  let intervalMs = Number(sliderIv.value);
  let lastProx = null;
  let blinkFlag = false; // set true when a rising-edge is detected since last bucket
  let timer = null;

  // Canvas setup (device pixel ratio aware)
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const ctx = canvasEl.getContext('2d');
  const bg = '#f9fafb';
  const barOn = '#10b981';
  const barOff = '#d1d5db';
  const midLine = '#e5e7eb';
  let barCssWidth = 4; // px in CSS space
  let barW = Math.round(barCssWidth * dpr);
  let x = 0; // draw head (in device px)

  function resizeCanvas() {
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight; // CSS px
    canvasEl.width = Math.floor(w * dpr);
    canvasEl.height = Math.floor(h * dpr);
    barW = Math.max(1, Math.round(barCssWidth * dpr));
    // Reset background
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
    // Midline
    ctx.fillStyle = midLine;
    ctx.fillRect(0, Math.floor(canvasEl.height * 0.5), canvasEl.width, Math.max(1, Math.floor(1 * dpr)));
    // Put draw head at right edge if canvas shrank; otherwise keep it
    x = Math.min(x, canvasEl.width - barW);
  }

  function drawBar(val) {
    const W = canvasEl.width;
    const H = canvasEl.height;
    if (W === 0 || H === 0) return;

    // If we reached end, scroll left by one bar
    if (x + barW > W) {
      // Scroll the whole canvas left by barW
      // drawImage(sx, sy, sw, sh, dx, dy, dw, dh)
      ctx.drawImage(canvasEl, barW, 0, W - barW, H, 0, 0, W - barW, H);
      // Clear the rightmost column where new bar goes
      ctx.fillStyle = bg;
      ctx.fillRect(W - barW, 0, barW, H);
      // Redraw midline across cleared area
      ctx.fillStyle = midLine;
      ctx.fillRect(W - barW, Math.floor(H * 0.5), barW, Math.max(1, Math.floor(1 * dpr)));
      x = W - barW;
    }

    // Compute bar height: tall for 1, short for 0
    const hTall = Math.floor(H * 0.8);
    const hShort = Math.floor(H * 0.25);
    const h = val ? hTall : hShort;
    const y = H - h; // draw from bottom up

    ctx.fillStyle = val ? barOn : barOff;
    ctx.fillRect(x, y, barW, h);
    x += barW;
  }

  function tick() {
    const bit = blinkFlag ? 1 : 0;
    drawBar(bit);
    blinkFlag = false;
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, intervalMs);
  }

  // UI events
  sliderTh.addEventListener('input', () => {
    threshold = Number(sliderTh.value);
    thVal.textContent = String(threshold);
  });
  sliderIv.addEventListener('input', () => {
    intervalMs = Number(sliderIv.value);
    intVal.textContent = String(intervalMs);
    startTimer();
  });

  // Handle incoming serial samples
  function handleSample(t, prox) {
    stats.textContent = `t: ${t} ms, prox: ${prox}`;
    if (lastProx == null) { lastProx = prox; return; }
    if (lastProx < threshold && prox >= threshold) {
      blinkFlag = true;
    }
    lastProx = prox;
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.addEventListener('open', () => {
      console.log('ws: open');
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'sample') handleSample(msg.t, msg.prox);
      } catch {}
    });
    ws.addEventListener('close', () => {
      console.log('ws: closed, retrying…');
      setTimeout(connect, 1000);
    });
  }

  // Init
  thVal.textContent = String(threshold);
  intVal.textContent = String(intervalMs);
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  startTimer();
  connect();
})();
