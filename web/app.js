'use strict';
/* Пульт — клиент для iPhone (Safari / иконка на экране «Домой»). */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const video = $('#video');
const stage = $('#stage');
const viewportEl = $('#viewport');
const touchEl = $('#touch');
const cursorEl = $('#cursor');
const ringEl = $('#ring');
const kbd = $('#kbd');

const QUALITY = {
  eco:      { w: 960,  fps: 20, kbps: 800,  hint: 'Для слабого интернета или мобильной сети' },
  balanced: { w: 1280, fps: 30, kbps: 2500, hint: 'Оптимально для большинства сетей' },
  sharp:    { w: 1920, fps: 30, kbps: 6000, hint: 'Мелкий текст читается лучше, нужна хорошая сеть' },
  smooth:   { w: 1280, fps: 60, kbps: 5000, hint: 'Плавно, но сильнее грузит ноутбук' },
};

const store = {
  get(k, d) { try { const v = localStorage.getItem('pult.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pult.' + k, JSON.stringify(v)); } catch {} },
};

const S = {
  token: null,
  pc: null,
  dc: null,
  connected: false,
  reconnectTimer: null,
  retries: 0,
  lastPong: 0,
  os: 'windows',
  monitors: [],
  mon: 0,
  mode: store.get('mode', 'touch'),           // 'touch' | 'trackpad'
  quality: store.get('quality', 'balanced'),
  sens: store.get('sens', 1.6),
  scrollSpeed: store.get('scrollSpeed', 1.0),
  showStats: store.get('showStats', false),
  mods: new Set(),
  // геометрия
  W: 0, H: 0, baseX: 0, baseY: 0, baseW: 1, baseH: 1,
  scale: 1, tx: 0, ty: 0,
  cursor: null,                               // {x, y} 0..1
};

/* ====================================================================== */
/* Связь с ноутбуком                                                      */
/* ====================================================================== */

const pending = { move: null, rel: null, scroll: null };

function rawSend(obj) {
  const dc = S.dc;
  if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj));
}

function flush() {
  if (pending.move) { rawSend({ t: 'move', ...pending.move }); pending.move = null; }
  if (pending.rel) {
    rawSend({ t: 'rel', dx: +pending.rel.dx.toFixed(6), dy: +pending.rel.dy.toFixed(6) });
    pending.rel = null;
  }
  if (pending.scroll) {
    rawSend({ t: 'scroll', dx: Math.round(pending.scroll.dx), dy: Math.round(pending.scroll.dy) });
    pending.scroll = null;
  }
}

/* Дискретные команды: сначала досылаем накопленные движения, чтобы не нарушить порядок. */
function send(obj) { flush(); rawSend(obj); }

let flushScheduled = false;
function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => { flushScheduled = false; flush(); });
}

function queueMove(x, y) { pending.move = { x: +x.toFixed(5), y: +y.toFixed(5) }; scheduleFlush(); }
function queueRel(dx, dy) {
  if (!pending.rel) pending.rel = { dx: 0, dy: 0 };
  pending.rel.dx += dx; pending.rel.dy += dy;
  scheduleFlush();
}
function queueScroll(dx, dy) {
  if (!pending.scroll) pending.scroll = { dx: 0, dy: 0 };
  pending.scroll.dx += dx; pending.scroll.dy += dy;
  scheduleFlush();
}

function setStatus(text) {
  $('#status-text').textContent = text || '';
  $('#status').classList.toggle('hidden', !text);
}

function waitIceGathering(pc, timeout) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, timeout);
  });
}

function closePeer() {
  if (S.dc) { try { S.dc.close(); } catch {} }
  if (S.pc) { try { S.pc.close(); } catch {} }
  S.dc = null; S.pc = null; S.connected = false;
}

function scheduleReconnect(delay) {
  clearTimeout(S.reconnectTimer);
  if (!S.token) return;
  const d = delay ?? Math.min(500 * 2 ** S.retries, 5000);
  S.retries++;
  S.reconnectTimer = setTimeout(connect, d);
}

async function connect() {
  clearTimeout(S.reconnectTimer);
  if (!S.token) { showLogin(); return; }
  closePeer();
  setStatus(S.retries ? 'Переподключение…' : 'Подключение…');

  const pc = new RTCPeerConnection({ iceServers: [] });
  S.pc = pc;
  const dc = pc.createDataChannel('ctl', { ordered: true });
  S.dc = dc;

  dc.onopen = () => {
    S.lastPong = performance.now();
    applyQuality(S.quality, false);
  };
  dc.onmessage = (e) => { try { onServerMessage(JSON.parse(e.data)); } catch {} };

  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = (e) => {
    try { e.receiver.jitterBufferTarget = 0; } catch {}
    try { e.receiver.playoutDelayHint = 0; } catch {}
    video.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
    video.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (S.pc !== pc) return;
    const st = pc.connectionState;
    if (st === 'connected') {
      S.connected = true; S.retries = 0;
      setStatus(video.videoWidth ? '' : 'Ожидание изображения…');
      requestWakeLock();
    } else if (st === 'failed' || st === 'closed') {
      S.connected = false;
      setStatus('Связь потеряна. Переподключение…');
      scheduleReconnect();
    } else if (st === 'disconnected') {
      setStatus('Связь прервалась…');
      // Даём шанс восстановиться самому, потом переподключаемся.
      clearTimeout(S.reconnectTimer);
      S.reconnectTimer = setTimeout(() => {
        if (S.pc === pc && pc.connectionState !== 'connected') connect();
      }, 2500);
    }
  };

  try {
    await pc.setLocalDescription(await pc.createOffer());
    await waitIceGathering(pc, 1500);
    const res = await fetch('offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: pc.localDescription.sdp, type: pc.localDescription.type, token: S.token }),
    });
    if (S.pc !== pc) return;
    if (res.status === 401) { S.token = null; store.set('token', null); showLogin('Неверный код доступа'); return; }
    if (res.status === 429) { setStatus('Слишком много неверных попыток. Подождите минуту.'); scheduleReconnect(60000); return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await pc.setRemoteDescription(await res.json());
  } catch (err) {
    if (S.pc !== pc) return;
    setStatus('Ноутбук недоступен. Повтор…');
    scheduleReconnect();
  }
}

function onServerMessage(m) {
  switch (m.t) {
    case 'hello':
      S.os = m.os; S.monitors = m.monitors || []; S.mon = m.mon || 0;
      document.title = 'Пульт — ' + (m.host || '');
      renderOsLabels(); renderMonitors();
      break;
    case 'cur':
      S.cursor = (m.x === undefined) ? null : { x: m.x, y: m.y };
      renderCursor();
      break;
    case 'pong':
      S.lastPong = performance.now();
      if (m.ts) S.appRtt = performance.now() - m.ts;
      break;
  }
}

/* Проверка живости: если ноутбук молчит 6 с — переподключаемся. */
setInterval(() => {
  if (!S.dc || S.dc.readyState !== 'open') return;
  rawSend({ t: 'ping', ts: performance.now() });
  if (performance.now() - S.lastPong > 6000 && S.connected) {
    setStatus('Нет ответа. Переподключение…');
    connect();
  }
}, 2000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    send({ t: 'release' });          // не оставляем зажатые кнопки
    return;
  }
  requestWakeLock();
  if (!S.pc || S.pc.connectionState !== 'connected') { S.retries = 0; connect(); }
});

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {}
}

/* ====================================================================== */
/* Геометрия: вписывание, увеличение, курсор                              */
/* ====================================================================== */

function layout() {
  const r = viewportEl.getBoundingClientRect();
  S.W = r.width; S.H = r.height;
  const vw = video.videoWidth || 16, vh = video.videoHeight || 10;
  const k = Math.min(S.W / vw, S.H / vh);
  S.baseW = vw * k; S.baseH = vh * k;
  S.baseX = (S.W - S.baseW) / 2; S.baseY = (S.H - S.baseH) / 2;
  stage.style.left = S.baseX + 'px'; stage.style.top = S.baseY + 'px';
  stage.style.width = S.baseW + 'px'; stage.style.height = S.baseH + 'px';
  clampView(); applyView();
}

function clampView() {
  S.scale = Math.min(Math.max(S.scale, 1), 6);
  const cw = S.baseW * S.scale, ch = S.baseH * S.scale;
  if (cw <= S.W) S.tx = (S.W - cw) / 2 - S.baseX;
  else S.tx = Math.min(-S.baseX, Math.max(S.W - cw - S.baseX, S.tx));
  if (ch <= S.H) S.ty = (S.H - ch) / 2 - S.baseY;
  else S.ty = Math.min(-S.baseY, Math.max(S.H - ch - S.baseY, S.ty));
}

function applyView() {
  stage.style.transform = `translate3d(${S.tx}px, ${S.ty}px, 0) scale(${S.scale})`;
  renderCursor();
}

/* Точка на экране телефона (относительно #viewport) → координаты 0..1 на ноутбуке */
function toRemote(px, py) {
  const x = (px - S.baseX - S.tx) / (S.baseW * S.scale);
  const y = (py - S.baseY - S.ty) / (S.baseH * S.scale);
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function renderCursor() {
  if (!S.cursor || !video.videoWidth) { cursorEl.style.display = 'none'; return; }
  cursorEl.style.display = 'block';
  const x = S.cursor.x * S.baseW, y = S.cursor.y * S.baseH;
  cursorEl.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${1 / S.scale})`;
}

/* В режиме тачпада при увеличении экран следует за курсором. */
function followCursor() {
  if (S.mode !== 'trackpad' || S.scale <= 1.01 || !S.cursor) return;
  const sx = S.baseX + S.tx + S.cursor.x * S.baseW * S.scale;
  const sy = S.baseY + S.ty + S.cursor.y * S.baseH * S.scale;
  const m = 50;
  let dx = 0, dy = 0;
  if (sx < m) dx = m - sx; else if (sx > S.W - m) dx = S.W - m - sx;
  if (sy < m) dy = m - sy; else if (sy > S.H - m) dy = S.H - m - sy;
  if (dx || dy) { S.tx += dx; S.ty += dy; clampView(); applyView(); }
}

function zoomAt(px, py, newScale) {
  const cx = (px - S.baseX - S.tx) / S.scale;
  const cy = (py - S.baseY - S.ty) / S.scale;
  S.scale = Math.min(Math.max(newScale, 1), 6);
  S.tx = px - S.baseX - cx * S.scale;
  S.ty = py - S.baseY - cy * S.scale;
  clampView(); applyView();
}

video.addEventListener('resize', () => { layout(); if (S.connected) setStatus(''); });
video.addEventListener('loadedmetadata', () => { layout(); setStatus(''); });
window.addEventListener('resize', () => setTimeout(layout, 50));
window.addEventListener('orientationchange', () => setTimeout(layout, 300));

/* Клавиатура iOS перекрывает низ экрана — поднимаем панель над ней. */
if (window.visualViewport) {
  const onVV = () => {
    const vv = window.visualViewport;
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', (kb > 60 ? kb : 0) + 'px');
    window.scrollTo(0, 0);
    layout();
  };
  visualViewport.addEventListener('resize', onVV);
  visualViewport.addEventListener('scroll', onVV);
}

/* ====================================================================== */
/* Жесты                                                                  */
/* ====================================================================== */

const TAP_SLOP = 10;        // px: смещение, после которого это уже не тап
const TAP_TIME = 350;       // мс
const LONG_PRESS = 450;     // мс
const DOUBLE_TAP_TIME = 400;
const DOUBLE_TAP_DIST = 30;

let g = null;               // текущий жест
let lastTap = null;         // {time, px, py, rx, ry} — для двойного тапа
let inertia = null;

function haptic() {
  try { $('#haptic').click(); } catch {}
}

function local(t) {
  const r = viewportEl.getBoundingClientRect();
  return { x: t.clientX - r.left, y: t.clientY - r.top };
}
function findTouch(list, id) {
  for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
  return null;
}
function takeMods() {
  const mods = Array.from(S.mods);
  if (mods.length) { S.mods.clear(); renderMods(); }
  return mods;
}

function showRing(x, y) { ringEl.style.left = x + 'px'; ringEl.style.top = y + 'px'; ringEl.style.display = 'block'; }
function hideRing() { ringEl.style.display = 'none'; }

function stopInertia() { if (inertia) { cancelAnimationFrame(inertia.raf); inertia = null; } }
function startInertia(vx, vy) {
  if (Math.hypot(vx, vy) < 0.3) return;      // px/мс
  let last = performance.now();
  inertia = { vx, vy, raf: 0 };
  const step = (now) => {
    if (!inertia) return;
    const dt = Math.min(now - last, 50); last = now;
    inertia.vx *= Math.pow(0.94, dt / 16); inertia.vy *= Math.pow(0.94, dt / 16);
    if (Math.hypot(inertia.vx, inertia.vy) < 0.05) { inertia = null; return; }
    remoteScroll(inertia.vx * dt, inertia.vy * dt);
    inertia.raf = requestAnimationFrame(step);
  };
  inertia.raf = requestAnimationFrame(step);
}

/* Прокрутка на ноутбуке: переводим пиксели пальца в пиксели экрана ноутбука. */
function remoteScroll(dx, dy) {
  const mon = S.monitors[S.mon];
  const k = (mon ? mon.w / (S.baseW * S.scale) : 3) * 0.5 * S.scrollSpeed;
  queueScroll(dx * k, dy * k);
}

function trackVelocity(o, dx, dy) {
  const now = performance.now();
  const dt = Math.max(1, now - (o.vt || now - 16));
  o.vt = now;
  const a = 0.6;
  o.vx = a * (dx / dt) + (1 - a) * (o.vx || 0);
  o.vy = a * (dy / dt) + (1 - a) * (o.vy || 0);
}

touchEl.addEventListener('touchstart', (e) => {
  e.preventDefault();
  stopInertia();
  hidePanels();
  const n = e.touches.length;
  const now = performance.now();

  if (n === 1) {
    const p = local(e.touches[0]);
    g = { type: 'one', id: e.touches[0].identifier, sx: p.x, sy: p.y, x: p.x, y: p.y, t0: now,
          moved: false, held: false, dragging: false, scrolling: false };
    g.timer = setTimeout(() => {
      if (!g || g.type !== 'one' || g.moved) return;
      g.held = true; haptic(); showRing(g.x, g.y);
    }, LONG_PRESS);
  } else if (n === 2) {
    if (g && g.type === 'one') {
      clearTimeout(g.timer); hideRing();
      if (g.dragging) send({ t: 'up', b: 'left' });
    }
    const a = local(e.touches[0]), b = local(e.touches[1]);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    g = { type: 'two', ids: [e.touches[0].identifier, e.touches[1].identifier], t0: now,
          d0: Math.hypot(a.x - b.x, a.y - b.y), mid0: mid, mid, s0: S.scale, how: null, moved: false };
  } else if (n >= 3) {
    if (g && g.dragging) send({ t: 'up', b: 'left' });
    g = { type: 'three', t0: now, moved: false };
  }
}, { passive: false });

touchEl.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!g) return;

  if (g.type === 'one') {
    const t = findTouch(e.touches, g.id); if (!t) return;
    const p = local(t);
    const dx = p.x - g.x, dy = p.y - g.y;
    if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) > TAP_SLOP) {
      g.moved = true;
      clearTimeout(g.timer);
      if (g.held) {
        // удержание + движение = перетаскивание левой кнопкой
        g.dragging = true; hideRing();
        if (S.mode === 'touch') {
          const r = toRemote(g.sx, g.sy);
          send({ t: 'down', b: 'left', x: r.x, y: r.y, mods: takeMods() });
        } else {
          send({ t: 'down', b: 'left', mods: takeMods() });
        }
      } else if (S.mode === 'touch') {
        g.scrolling = S.scale <= 1.01;
      }
    }
    if (g.moved) {
      if (S.mode === 'touch') {
        if (g.dragging) { const r = toRemote(p.x, p.y); queueMove(r.x, r.y); }
        else if (g.scrolling) { remoteScroll(dx, dy); trackVelocity(g, dx, dy); }
        else { S.tx += dx; S.ty += dy; clampView(); applyView(); }
      } else {
        // тачпад: относительное движение с ускорением
        const now = performance.now();
        const dt = Math.max(1, now - (g.lt || now - 16)); g.lt = now;
        const speed = Math.hypot(dx, dy) / dt;              // px/мс
        const gain = S.sens * (0.6 + Math.min(speed, 3) * 0.9);
        queueRel(dx * gain / (S.baseW * S.scale), dy * gain / (S.baseH * S.scale));
      }
    }
    g.x = p.x; g.y = p.y;
  } else if (g.type === 'two') {
    const a = findTouch(e.touches, g.ids[0]), b = findTouch(e.touches, g.ids[1]);
    if (!a || !b) return;
    const pa = local(a), pb = local(b);
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    if (!g.how) {
      if (Math.abs(d - g.d0) > 28) {
        g.how = 'zoom';
        g.cx = (g.mid0.x - S.baseX - S.tx) / S.scale;   // точка контента под пальцами
        g.cy = (g.mid0.y - S.baseY - S.ty) / S.scale;
      } else if (Math.hypot(mid.x - g.mid0.x, mid.y - g.mid0.y) > TAP_SLOP) {
        g.how = 'scroll';
      }
      if (g.how) g.moved = true;
    }
    if (g.how === 'zoom') {
      S.scale = Math.min(Math.max(g.s0 * d / g.d0, 1), 6);
      S.tx = mid.x - S.baseX - g.cx * S.scale;
      S.ty = mid.y - S.baseY - g.cy * S.scale;
      clampView(); applyView();
    } else if (g.how === 'scroll') {
      const dx = mid.x - g.mid.x, dy = mid.y - g.mid.y;
      remoteScroll(dx, dy); trackVelocity(g, dx, dy);
    }
    g.mid = mid;
  } else if (g.type === 'three') {
    g.moved = true;
  }
}, { passive: false });

function endGesture(e, cancelled) {
  e.preventDefault();
  if (!g) return;
  const now = performance.now();
  const left = e.touches.length;

  if (g.type === 'one') {
    clearTimeout(g.timer); hideRing();
    if (cancelled) { if (g.dragging) send({ t: 'up', b: 'left' }); g = null; return; }
    if (g.dragging) {
      if (S.mode === 'touch') { const r = toRemote(g.x, g.y); send({ t: 'up', b: 'left', x: r.x, y: r.y }); }
      else send({ t: 'up', b: 'left' });
    } else if (g.held && !g.moved) {
      // долгое нажатие = правый клик
      if (S.mode === 'touch') { const r = toRemote(g.sx, g.sy); send({ t: 'click', b: 'right', x: r.x, y: r.y, mods: takeMods() }); }
      else send({ t: 'click', b: 'right', mods: takeMods() });
    } else if (!g.moved && now - g.t0 < TAP_TIME + LONG_PRESS) {
      if (S.mode === 'touch') {
        let r = toRemote(g.sx, g.sy);
        // второй тап двойного клика попадает в ту же точку, иначе ОС не засчитает
        if (lastTap && now - lastTap.time < DOUBLE_TAP_TIME &&
            Math.hypot(g.sx - lastTap.px, g.sy - lastTap.py) < DOUBLE_TAP_DIST) r = { x: lastTap.rx, y: lastTap.ry };
        lastTap = { time: now, px: g.sx, py: g.sy, rx: r.x, ry: r.y };
        send({ t: 'click', b: 'left', x: r.x, y: r.y, mods: takeMods() });
      } else {
        send({ t: 'click', b: 'left', mods: takeMods() });
      }
    } else if (g.scrolling) {
      startInertia(g.vx || 0, g.vy || 0);
    }
    g = null;
  } else if (g.type === 'two') {
    if (!cancelled) {
      if (!g.moved && now - g.t0 < TAP_TIME) {
        if (S.mode === 'touch') { const r = toRemote(g.mid0.x, g.mid0.y); send({ t: 'click', b: 'right', x: r.x, y: r.y, mods: takeMods() }); }
        else send({ t: 'click', b: 'right', mods: takeMods() });
        g.moved = true;   // не повторять при отпускании второго пальца
      } else if (g.how === 'scroll' && left === 0) {
        startInertia(g.vx || 0, g.vy || 0);
      }
    }
    // Если один палец ещё на экране — игнорируем его до полного отпускания.
    g = left === 0 ? null : { type: 'rest', moved: true };
  } else if (g.type === 'three') {
    if (!cancelled && !g.moved && now - g.t0 < TAP_TIME * 1.5) toggleKeyboard();
    g = left === 0 ? null : { type: 'rest', moved: true };
  } else if (left === 0) {
    g = null;
  }
}
touchEl.addEventListener('touchend', (e) => endGesture(e, false), { passive: false });
touchEl.addEventListener('touchcancel', (e) => endGesture(e, true), { passive: false });

/* Запрет системного масштабирования страницы в Safari */
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

/* Мышь/трекпад на iPad или в браузере компьютера (для отладки) */
let mouseDown = false;
touchEl.addEventListener('mousedown', (e) => {
  const p = local(e); const r = toRemote(p.x, p.y);
  mouseDown = true;
  send({ t: 'down', b: e.button === 2 ? 'right' : 'left', x: r.x, y: r.y, mods: takeMods() });
});
touchEl.addEventListener('mousemove', (e) => { const p = local(e); const r = toRemote(p.x, p.y); queueMove(r.x, r.y); });
touchEl.addEventListener('mouseup', (e) => {
  if (!mouseDown) return; mouseDown = false;
  const p = local(e); const r = toRemote(p.x, p.y);
  send({ t: 'up', b: e.button === 2 ? 'right' : 'left', x: r.x, y: r.y });
});
touchEl.addEventListener('contextmenu', (e) => e.preventDefault());
touchEl.addEventListener('wheel', (e) => { e.preventDefault(); queueScroll(-e.deltaX, -e.deltaY); }, { passive: false });

/* ====================================================================== */
/* Клавиатура                                                             */
/* ====================================================================== */

// В поле всегда лежит невидимый «запас» символов, чтобы iOS присылала ⌫ даже в пустом поле.
const SENTINEL = '​​​';
let kbdPrev = SENTINEL;

function resetKbd() {
  kbd.value = SENTINEL; kbdPrev = SENTINEL;
  try { kbd.setSelectionRange(SENTINEL.length, SENTINEL.length); } catch {}
}

function toggleKeyboard() {
  if (document.activeElement === kbd) { kbd.blur(); return; }
  resetKbd();
  kbd.focus();
}

kbd.addEventListener('focus', () => { $('#btn-kbd').classList.add('on'); resetKbd(); });
kbd.addEventListener('blur', () => {
  $('#btn-kbd').classList.remove('on');
  document.documentElement.style.setProperty('--kb', '0px');
  window.scrollTo(0, 0);
  setTimeout(layout, 100);
});

kbd.addEventListener('input', () => {
  const v = kbd.value;
  let i = 0;
  while (i < kbdPrev.length && i < v.length && kbdPrev[i] === v[i]) i++;
  const deleted = kbdPrev.length - i;
  const inserted = v.slice(i).replace(/​/g, '');
  for (let k = 0; k < deleted; k++) send({ t: 'key', k: 'backspace' });
  if (inserted) {
    if (S.mods.size && inserted.length === 1) send({ t: 'key', k: inserted.toLowerCase(), mods: takeMods() });
    else send({ t: 'text', s: inserted });
  }
  kbdPrev = v;
  if (!v.startsWith(SENTINEL) || (v.length > 60 && /\s$/.test(v))) resetKbd();
});

const HW_KEYS = {
  Enter: 'enter', Escape: 'esc', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left',
  ArrowRight: 'right', Home: 'home', End: 'end', PageUp: 'page_up', PageDown: 'page_down', Delete: 'delete',
};
kbd.addEventListener('keydown', (e) => {
  // Внешняя клавиатура (iPad / Bluetooth): сочетания и служебные клавиши
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.metaKey) mods.push('cmd');
  if (HW_KEYS[e.key]) {
    if (e.shiftKey) mods.push('shift');
    e.preventDefault();
    send({ t: 'key', k: HW_KEYS[e.key], mods: mods.concat(takeMods()) });
    resetKbd();
  } else if (mods.length && e.key.length === 1) {
    e.preventDefault();
    send({ t: 'key', k: e.key.toLowerCase(), mods });
  }
});

/* ====================================================================== */
/* Панели и кнопки                                                        */
/* ====================================================================== */

function hidePanels() {
  $('#panel-keys').hidden = true; $('#panel-settings').hidden = true;
  $('#btn-keys').classList.remove('on'); $('#btn-settings').classList.remove('on');
}
function togglePanel(id, btn) {
  const p = $(id); const open = p.hidden;
  hidePanels();
  p.hidden = !open; $(btn).classList.toggle('on', open);
}

/* Нажатие кнопок без задержки и без потери фокуса клавиатуры */
function onTap(el, fn) {
  el.addEventListener('touchend', (e) => { e.preventDefault(); fn(e); }, { passive: false });
  el.addEventListener('click', fn);
}

onTap($('#btn-kbd'), toggleKeyboard);
onTap($('#btn-keys'), () => togglePanel('#panel-keys', '#btn-keys'));
onTap($('#btn-settings'), () => togglePanel('#panel-settings', '#btn-settings'));
onTap($('#btn-fit'), () => { S.scale = 1; clampView(); applyView(); });
onTap($('#btn-mode'), () => { S.mode = S.mode === 'touch' ? 'trackpad' : 'touch'; store.set('mode', S.mode); renderMode(); });
onTap($('#btn-hide'), () => { hidePanels(); document.body.classList.add('bar-hidden'); $('#btn-show').hidden = false; setTimeout(layout, 30); });
onTap($('#btn-show'), () => { document.body.classList.remove('bar-hidden'); $('#btn-show').hidden = true; setTimeout(layout, 30); });

function renderMode() { $('#btn-mode').textContent = S.mode === 'touch' ? 'Касание' : 'Тачпад'; }

/* Залипающие модификаторы: нажал Ctrl → следующая клавиша/клик пойдёт с Ctrl */
$$('.mod').forEach((b) => onTap(b, () => {
  const m = b.dataset.mod;
  if (S.mods.has(m)) S.mods.delete(m); else S.mods.add(m);
  renderMods();
}));
function renderMods() { $$('.mod').forEach((b) => b.classList.toggle('on', S.mods.has(b.dataset.mod))); }

$$('#panel-keys [data-key]').forEach((b) => onTap(b, () => send({ t: 'key', k: b.dataset.key, mods: takeMods() })));

function shortcuts() {
  const mac = S.os === 'mac';
  const P = mac ? 'cmd' : 'ctrl';
  const list = [
    ['Копировать', 'c', [P]], ['Вставить', 'v', [P]], ['Вырезать', 'x', [P]],
    ['Отменить', 'z', [P]], ['Выделить всё', 'a', [P]], ['Найти', 'f', [P]],
    ['Сохранить', 's', [P]], ['Новая вкладка', 't', [P]], ['Закрыть вкладку', 'w', [P]],
    ['Сменить окно', 'tab', [mac ? 'cmd' : 'alt']],
  ];
  if (mac) {
    list.push(['Закрыть прогр.', 'q', ['cmd']], ['Spotlight', 'space', ['cmd']], ['Завершить…', 'esc', ['cmd', 'alt']]);
  } else if (S.os === 'windows') {
    list.push(['Закрыть окно', 'f4', ['alt']], ['Пуск', 'cmd', []], ['Рабочий стол', 'd', ['cmd']],
              ['Диспетчер задач', 'esc', ['ctrl', 'shift']], ['Проводник', 'e', ['cmd']]);
  } else {
    list.push(['Закрыть окно', 'f4', ['alt']], ['Меню', 'cmd', []]);
  }
  return list;
}

function renderOsLabels() {
  const mac = S.os === 'mac';
  $$('.mod').forEach((b) => {
    if (b.dataset.labelMac) b.textContent = mac ? b.dataset.labelMac : (b.dataset.labelWin || b.dataset.mod[0].toUpperCase() + b.dataset.mod.slice(1));
  });
  const box = $('#shortcuts'); box.innerHTML = '';
  for (const [label, key, mods] of shortcuts()) {
    const b = document.createElement('button');
    b.textContent = label;
    onTap(b, () => send({ t: 'key', k: key, mods: mods.concat(takeMods()) }));
    box.appendChild(b);
  }
}

function renderMonitors() {
  const box = $('#monitors'); box.innerHTML = '';
  const many = S.monitors.length > 1;
  box.hidden = !many; $('#monitors-label').hidden = !many;
  S.monitors.forEach((m, i) => {
    const b = document.createElement('button');
    b.textContent = `${i + 1}: ${m.w}×${m.h}`;
    b.classList.toggle('on', i === S.mon);
    onTap(b, () => { send({ t: 'mon', i }); S.scale = 1; });
    box.appendChild(b);
  });
}

function applyQuality(name, save = true) {
  if (!QUALITY[name]) name = 'balanced';
  S.quality = name; if (save) store.set('quality', name);
  const q = QUALITY[name];
  send({ t: 'cfg', w: q.w, fps: q.fps, kbps: q.kbps });
  $$('#quality button').forEach((b) => b.classList.toggle('on', b.dataset.q === name));
  $('#quality-hint').textContent = `${q.hint} (${q.w}px, ${q.fps} fps)`;
}
$$('#quality button').forEach((b) => onTap(b, () => applyQuality(b.dataset.q)));

const sens = $('#sens'); sens.value = S.sens;
sens.addEventListener('input', () => { S.sens = +sens.value; store.set('sens', S.sens); });
const sspeed = $('#scrollspeed'); sspeed.value = S.scrollSpeed;
sspeed.addEventListener('input', () => { S.scrollSpeed = +sspeed.value; store.set('scrollSpeed', S.scrollSpeed); });
const showstats = $('#showstats'); showstats.checked = S.showStats;
showstats.addEventListener('change', () => { S.showStats = showstats.checked; store.set('showStats', S.showStats); $('#stats').hidden = !S.showStats; });
$('#stats').hidden = !S.showStats;

onTap($('#btn-reconnect'), () => { hidePanels(); S.retries = 0; connect(); });
onTap($('#btn-logout'), () => { hidePanels(); closePeer(); S.token = null; store.set('token', null); history.replaceState(null, '', location.pathname); showLogin(); });

/* ====================================================================== */
/* Статистика                                                             */
/* ====================================================================== */

let lastBytes = 0, lastTs = 0;
setInterval(async () => {
  if (!S.showStats || !S.pc) return;
  try {
    const stats = await S.pc.getStats();
    let fps = 0, kbps = 0, rtt = null, via = '';
    let selected = null, selectedId = null;
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        fps = r.framesPerSecond || 0;
        if (lastTs) kbps = ((r.bytesReceived - lastBytes) * 8) / (r.timestamp - lastTs);
        lastBytes = r.bytesReceived; lastTs = r.timestamp;
      }
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') selected = r;
      if (r.type === 'transport' && r.selectedCandidatePairId) selectedId = r.selectedCandidatePairId;
    });
    if (selectedId && stats.get(selectedId)) selected = stats.get(selectedId);
    if (selected) {
      if (selected.currentRoundTripTime !== undefined) rtt = Math.round(selected.currentRoundTripTime * 1000);
      const remote = stats.get(selected.remoteCandidateId);
      if (remote && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(remote.address || remote.ip || '')) via = ' · Tailscale';
    }
    if (rtt === null && S.appRtt) rtt = Math.round(S.appRtt);
    $('#stats').textContent = `${Math.round(fps)} fps · ${rtt ?? '?'} мс · ${(kbps / 1000).toFixed(1)} Мбит/с${via}`;
  } catch {}
}, 1000);

/* ====================================================================== */
/* Вход                                                                   */
/* ====================================================================== */

function showLogin(error) {
  closePeer();
  setStatus('');
  $('#login').hidden = false;
  $('#login-error').textContent = error || '';
  $('#login-token').value = '';
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#login-token').value.trim();
  if (!t) return;
  S.token = t; store.set('token', t);
  // Код в адресе — чтобы иконка «На экран Домой» открывалась уже с ним.
  history.replaceState(null, '', location.pathname + '#t=' + encodeURIComponent(t));
  $('#login').hidden = true;
  $('#login-token').blur();
  S.retries = 0;
  connect();
});

function init() {
  const m = location.hash.match(/t=([^&]+)/);
  S.token = m ? decodeURIComponent(m[1]) : store.get('token', null);
  if (S.token) store.set('token', S.token);
  renderMode(); renderOsLabels(); layout();
  $$('#quality button').forEach((b) => b.classList.toggle('on', b.dataset.q === S.quality));
  if (S.token) connect(); else showLogin();
}
init();
