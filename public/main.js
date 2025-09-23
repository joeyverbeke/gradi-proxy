(() => {
  const canvas = document.getElementById('canvas');
  const slider = document.getElementById('threshold');
  const thVal  = document.getElementById('thVal');
  const stats  = document.getElementById('stats');

  let threshold = Number(slider.value);
  let lastProx = null;
  let alt = false;

  slider.addEventListener('input', () => {
    threshold = Number(slider.value);
    thVal.textContent = String(threshold);
  });

  function addSquare() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const x = Math.max(0, Math.floor(Math.random() * (w - 16)));
    const y = Math.max(0, Math.floor(Math.random() * (h - 16)));
    const el = document.createElement('div');
    el.className = 'sq' + (alt ? ' alt' : '');
    alt = !alt;
    el.style.left = `${x}px`;
    el.style.top  = `${y}px`;
    canvas.appendChild(el);
    // Fade out older squares to keep it light
    const maxChildren = 500;
    if (canvas.children.length > maxChildren) {
      for (let i = 0; i < canvas.children.length - maxChildren; i++) {
        canvas.removeChild(canvas.firstChild);
      }
    }
  }

  function handleSample(t, prox) {
    stats.textContent = `t: ${t} ms, prox: ${prox}`;
    if (lastProx == null) { lastProx = prox; return; }
    // Trigger on upward crossing: last < threshold && curr >= threshold
    if (lastProx < threshold && prox >= threshold) {
      addSquare();
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
        if (msg.type === 'sample') {
          handleSample(msg.t, msg.prox);
        }
      } catch {}
    });
    ws.addEventListener('close', () => {
      console.log('ws: closed, retrying…');
      setTimeout(connect, 1000);
    });
  }

  thVal.textContent = String(threshold);
  connect();
})();

