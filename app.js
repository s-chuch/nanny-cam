(() => {
  'use strict';
  // Refuse to run inside someone else's frame (clickjacking)
  if (window.top !== window.self) { window.top.location = window.self.location; return; }

  const PREFIX = 'nanny-cam-v1-';
  const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)
  const CODE_LEN = 8;     // public: lets the viewer find the camera
  const SECRET_LEN = 26;  // private: ~128 bits, proves a viewer is allowed; never sent anywhere
  const KEY_RE = new RegExp(`^[${ALPHABET}]{${CODE_LEN + SECRET_LEN}}$`);
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }
  function setStatus(el, text, cls = '') {
    el.textContent = text;
    el.className = 'status ' + cls;
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------------- Crypto helpers ----------------
  function randomString(len) {
    // Rejection sampling so every character is equally likely
    const out = [];
    const limit = 256 - (256 % ALPHABET.length);
    while (out.length < len) {
      for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
        if (b < limit && out.length < len) out.push(ALPHABET[b % ALPHABET.length]);
      }
    }
    return out.join('');
  }
  const utf8 = (s) => new TextEncoder().encode(s);
  const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const nonce = () => toB64(crypto.getRandomValues(new Uint8Array(16)));

  const keyCache = new Map();
  function hmacKey(secret) {
    if (!keyCache.has(secret)) {
      keyCache.set(secret, crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
    }
    return keyCache.get(secret);
  }
  async function sign(secret, text) {
    return toB64(await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8(text)));
  }
  async function verify(secret, text, mac) {
    try { return await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64(mac), utf8(text)); }
    catch { return false; }
  }

  // DTLS fingerprints of both ends of a WebRTC connection. Signing these with the
  // shared secret means a server in the middle can't swap in its own keys.
  function fingerprints(getPc, timeoutMs = 15000) {
    const fp = (desc) => {
      const m = desc?.sdp?.match(/^a=fingerprint:(\S+) (\S+)/m);
      return m ? m[1].toLowerCase() + ' ' + m[2].toUpperCase() : null;
    };
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        const pc = getPc();
        const local = fp(pc?.localDescription), remote = fp(pc?.remoteDescription);
        if (local && remote) return resolve({ local, remote });
        if (Date.now() - start > timeoutMs) return reject(new Error('no fingerprints'));
        setTimeout(poll, 150);
      })();
    });
  }
  const transcript = (nc, nv, fpCam, fpView) => ['nc1', nc, nv, fpCam, fpView].join('|');
  const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
  const isFp = (m) => m && isStr(m.local) && isStr(m.remote);

  // Pairing key = public code + private secret, shown in groups of 4
  const groupKey = (k) => k.match(/.{1,4}/g).join('-');
  function parseKey(text) {
    const k = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!KEY_RE.test(k)) return null;
    return { code: k.slice(0, CODE_LEN), secret: k.slice(CODE_LEN) };
  }

  // Keep the screen awake while in use (supported on most modern phones)
  let wakeLock = null;
  async function keepAwake() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (camPeer || viewPeer)) keepAwake();
  });

  function beep(freq = 880) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime + 0.4);
      osc.onended = () => ctx.close();
    } catch {}
  }

  // ---------------- CAMERA ----------------
  let camPeer = null, localStream = null, facing = 'user';
  const viewers = new Map(); // peer id → { conn, call, name, since, stream, verified, mine, theirs }
  let pending = 0, failures = [], blockedUntil = 0, blockMs = 60000, blockedCount = 0;

  function camIdentity() {
    let code = store.get('camCode'), secret = store.get('camSecret');
    if (!code || !secret) {
      // First run, or upgrading from the version without secrets: start fresh
      code = randomString(CODE_LEN); secret = randomString(SECRET_LEN);
      store.set('camCode', code); store.set('camSecret', secret);
    }
    return { code, secret };
  }

  async function getCamera() {
    const old = localStream;
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    $('localVideo').srcObject = localStream;
    // Swap tracks for anyone already watching (each viewer has its own copy)
    for (const v of viewers.values()) {
      if (!v.call) continue;
      const fresh = localStream.clone();
      fresh.getTracks().forEach((t) => { t.enabled = v.verified; });
      const senders = v.call.peerConnection?.getSenders() || [];
      for (const track of fresh.getTracks()) {
        senders.find((s) => s.track?.kind === track.kind)?.replaceTrack(track);
      }
      v.stream?.getTracks().forEach((t) => t.stop());
      v.stream = fresh;
    }
    old?.getTracks().forEach((t) => t.stop());
  }

  async function startCamera() {
    show('camera');
    try {
      await getCamera();
    } catch (e) {
      setStatus($('camStatus'), 'Camera/microphone permission denied: ' + e.message, 'bad');
      return;
    }
    const { code, secret } = camIdentity();
    $('pairKey').textContent = groupKey(code + secret);
    keepAwake();
    connectCamPeer();
  }

  function connectCamPeer() {
    const camStatus = $('camStatus');
    const { code } = camIdentity();
    camPeer?.destroy();
    const peer = camPeer = new Peer(PREFIX + code);
    peer.on('open', renderViewers);
    peer.on('connection', (conn) => onViewerConnection(peer, conn));
    peer.on('disconnected', () => {
      setStatus(camStatus, 'Reconnecting…', 'bad');
      setTimeout(() => peer === camPeer && !peer.destroyed && peer.reconnect(), 2000);
    });
    peer.on('error', (err) => {
      if (peer !== camPeer) return;
      if (err.type === 'unavailable-id') {
        setStatus(camStatus, 'Code in use (camera open in another tab?). Retrying…', 'bad');
        setTimeout(() => peer === camPeer && connectCamPeer(), 5000);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        setStatus(camStatus, 'Network problem — retrying…', 'bad');
        setTimeout(() => peer === camPeer && connectCamPeer(), 5000);
      } else if (err.type !== 'peer-unavailable') {
        setStatus(camStatus, 'Error: ' + err.type, 'bad');
      }
    });
  }

  function onViewerConnection(peer, conn) {
    const now = Date.now();
    if (now < blockedUntil || pending >= 3 || viewers.size >= 6) {
      blockedCount++;
      conn.on('open', () => conn.close());
      renderViewers();
      return;
    }
    pending++;
    let state = 'wait', nc = null, fps = null;
    const settle = () => { if (state === 'wait') { state = 'done'; pending--; } };
    const timer = setTimeout(() => { if (state === 'wait') { settle(); conn.close(); } }, 15000);

    conn.on('open', async () => {
      try { fps = await fingerprints(() => conn.peerConnection); } catch { conn.close(); return; }
      nc = nonce();
      conn.send({ t: 'hello', nc });
    });

    conn.on('data', async (msg) => {
      if (!msg || typeof msg !== 'object' || peer !== camPeer) return;
      const { secret } = camIdentity();
      if (msg.t === 'auth' && state === 'wait' && nc && fps && isStr(msg.nv, 40) && isStr(msg.mac, 100)) {
        const T = transcript(nc, msg.nv, fps.local, fps.remote);
        const ok = await verify(secret, 'viewer|' + T, msg.mac);
        clearTimeout(timer);
        settle();
        if (!ok) {
          recordFailure();
          try { conn.send({ t: 'deny' }); } catch {}
          setTimeout(() => conn.close(), 300);
          return;
        }
        conn.send({ t: 'ok', mac: await sign(secret, 'camera|' + T) });
        const name = (typeof msg.name === 'string' ? msg.name : '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) || 'Viewer';
        startSendingTo(conn, name);
      } else if (msg.t === 'mfp' && isFp(msg)) {
        const v = viewers.get(conn.peer);
        if (v && v.conn === conn) { v.theirs = msg; checkViewerMedia(v); }
      }
    });

    conn.on('close', () => {
      clearTimeout(timer);
      settle();
      const v = viewers.get(conn.peer);
      if (v && v.conn === conn) dropViewer(conn.peer);
    });
    conn.on('error', () => conn.close());
  }

  function recordFailure() {
    const now = Date.now();
    failures = failures.filter((t) => now - t < 10 * 60000);
    failures.push(now);
    blockedCount++;
    if (failures.length >= 5) {
      blockedUntil = now + blockMs;
      blockMs = Math.min(blockMs * 2, 60 * 60000);
      failures = [];
    }
    renderViewers();
  }

  function startSendingTo(conn, name) {
    const old = viewers.get(conn.peer);
    if (old) dropViewer(conn.peer);
    // Each viewer gets its own copy of the camera, switched OFF until the video link is verified
    const stream = localStream.clone();
    stream.getTracks().forEach((t) => { t.enabled = false; });
    const call = camPeer.call(conn.peer, stream);
    const v = { conn, call, name, since: new Date(), stream, verified: false, mine: null, theirs: null };
    viewers.set(conn.peer, v);
    fingerprints(() => call.peerConnection)
      .then((fp) => { v.mine = fp; conn.send({ t: 'mfp', local: fp.local, remote: fp.remote }); checkViewerMedia(v); })
      .catch(() => dropViewer(conn.peer));
    call.on('close', () => { if (viewers.get(conn.peer) === v) dropViewer(conn.peer); });
    call.on('error', () => { if (viewers.get(conn.peer) === v) dropViewer(conn.peer); });
    renderViewers();
  }

  function checkViewerMedia(v) {
    if (!v.mine || !v.theirs || v.verified) return;
    if (v.theirs.local !== v.mine.remote || v.theirs.remote !== v.mine.local) {
      dropViewer(v.conn.peer); // someone is in the middle of the video link
      return;
    }
    v.verified = true;
    v.stream.getTracks().forEach((t) => { t.enabled = true; });
    // Let everyone near the camera know someone started watching
    beep(660); setTimeout(() => beep(990), 250);
    navigator.vibrate?.([200, 100, 200]);
    renderViewers();
  }

  function dropViewer(id) {
    const v = viewers.get(id);
    if (!v) return;
    viewers.delete(id);
    try { v.call?.close(); } catch {}
    try { v.conn?.close(); } catch {}
    v.stream?.getTracks().forEach((t) => t.stop());
    renderViewers();
  }

  function renderViewers() {
    const list = $('viewerList');
    list.textContent = '';
    const live = [...viewers.values()].filter((v) => v.verified);
    for (const [id, v] of viewers) {
      const row = el('div', 'item viewerrow');
      const info = el('div', 'grow');
      info.append(el('div', 'name', '👁 ' + v.name));
      const since = v.since.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      info.append(el('div', 'status', v.verified ? 'Watching since ' + since : 'Checking…'));
      // Disconnects for now; they still have the key, so "Remove all viewers" is the permanent fix
      const kick = el('button', 'small danger', 'Disconnect');
      kick.onclick = () => dropViewer(id);
      row.append(info, kick);
      list.append(row);
    }
    const names = live.map((v) => v.name).join(', ');
    $('liveBanner').textContent = '● LIVE — watched by ' + names;
    $('liveBanner').classList.toggle('show', live.length > 0);
    $('dimLive').textContent = '● LIVE — ' + names;
    $('dimLive').hidden = live.length === 0;

    let text = camPeer?.open ? 'Camera on — waiting for a paired phone' : 'Connecting…';
    if (live.length) text = `🟢 ${live.length} watching`;
    if (Date.now() < blockedUntil) text += ' · ⛔ blocking connections after wrong keys';
    else if (blockedCount) text += ` · ${blockedCount} blocked attempt${blockedCount > 1 ? 's' : ''}`;
    setStatus($('camStatus'), text, camPeer?.open ? 'ok' : '');
  }

  function pairingUrl() {
    const { code, secret } = camIdentity();
    return location.origin + location.pathname + '#pair=' + code + secret;
  }

  // Draw the pairing link as a QR code (white background, 4-module quiet zone)
  function drawQr() {
    const canvas = $('pairQr');
    if (typeof qrcode !== 'function') { canvas.hidden = true; return; }
    const qr = qrcode(0, 'M');
    qr.addData(pairingUrl());
    qr.make();
    const n = qr.getModuleCount(), quiet = 4;
    const scale = Math.floor(canvas.width / (n + quiet * 2));
    const size = (n + quiet * 2) * scale;
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  function clearQr() {
    const canvas = $('pairQr');
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }

  function stopCamera() {
    for (const id of [...viewers.keys()]) dropViewer(id);
    camPeer?.destroy(); camPeer = null;
    localStream?.getTracks().forEach((t) => t.stop()); localStream = null;
    wakeLock?.release?.(); wakeLock = null;
    $('liveBanner').classList.remove('show');
    $('dimLive').hidden = true;
    $('keyBox').hidden = true; clearQr();
    $('showKey').textContent = '🔑 Show key / QR';
    show('home');
  }

  $('goCamera').onclick = startCamera;
  $('stopCam').onclick = stopCamera;
  $('flipCam').onclick = async () => {
    facing = facing === 'user' ? 'environment' : 'user';
    try { await getCamera(); } catch (e) { alert('Could not switch camera: ' + e.message); }
  };
  $('revokeAll').onclick = () => {
    if (!confirm('Disconnect everyone and make a new pairing key?\n\nEvery phone (including yours) will need the new key to watch again.')) return;
    // New secret, same code: old phones are told to re-pair instead of "camera not found"
    store.set('camSecret', randomString(SECRET_LEN));
    for (const id of [...viewers.keys()]) dropViewer(id);
    const { code, secret } = camIdentity();
    $('pairKey').textContent = groupKey(code + secret);
    if (!$('keyBox').hidden) drawQr();
    blockedCount = 0;
    connectCamPeer();
  };
  $('showKey').onclick = () => {
    const box = $('keyBox');
    box.hidden = !box.hidden;
    if (box.hidden) clearQr(); else drawQr();
    $('showKey').textContent = box.hidden ? '🔑 Show key / QR' : '🙈 Hide key / QR';
  };
  $('shareLink').onclick = async () => {
    const { code, secret } = camIdentity();
    const url = location.origin + location.pathname + '#pair=' + code + secret;
    try {
      if (navigator.share) await navigator.share({ title: 'Nanny Cam pairing link', text: 'Open this to watch the nanny cam. Keep it private.', url });
      else { await navigator.clipboard.writeText(url); alert('Pairing link copied. Only send it to people you trust.'); }
    } catch {}
  };
  $('dimScreen').onclick = () => $('dim').classList.add('show');
  $('dim').onclick = () => $('dim').classList.remove('show');

  // ---------------- VIEWER ----------------
  // Saved cameras live on this phone only: [{ name, code, secret }]
  const loadCams = () => {
    try {
      const list = JSON.parse(store.get('cameras')) || [];
      return Array.isArray(list) ? list.filter((c) => c && typeof c.code === 'string' && typeof c.name === 'string') : [];
    } catch { return []; }
  };
  const saveCams = (list) => store.set('cameras', JSON.stringify(list));
  // Codes saved by the very first version
  if (store.get('lastCode') && !loadCams().length) {
    saveCams([{ name: 'Camera 1', code: store.get('lastCode') }]);
  }
  store.del('lastCode');

  function myName() {
    let name = store.get('viewerName');
    if (!name) {
      name = (prompt("Name for this phone (the camera shows who's watching):", 'Mom') || 'Viewer').trim().slice(0, 24) || 'Viewer';
      store.set('viewerName', name);
    }
    return name;
  }

  function addCamera(key, name) {
    const list = loadCams();
    const existing = list.find((c) => c.code === key.code);
    if (existing) {
      existing.secret = key.secret;
      if (name?.trim()) existing.name = name.trim().slice(0, 24);
      saveCams(list);
      return existing;
    }
    const cam = { code: key.code, secret: key.secret, name: name?.trim().slice(0, 24) || 'Camera ' + (list.length + 1) };
    list.push(cam);
    saveCams(list);
    return cam;
  }

  function renderCamList() {
    const box = $('camList');
    box.textContent = '';
    const list = loadCams();
    $('watchAll').hidden = list.filter((c) => c.secret).length < 2;
    $('myName').textContent = "👤 This phone's name: " + (store.get('viewerName') || 'not set');
    if (!list.length) {
      box.append(el('p', '', 'No cameras saved yet. Add one below.'));
      return;
    }
    for (const cam of list) {
      const row = el('div', 'item camrow');
      const info = el('div', 'grow');
      info.append(el('div', 'name', cam.name));
      info.append(cam.secret ? el('div', 'status', 'Paired 🔒') : el('div', 'status bad', 'Needs new pairing key'));
      const watch = el('button', 'small', cam.secret ? '▶️ Watch' : '🔑 Re-pair');
      watch.onclick = () => {
        if (cam.secret) { startWatching([cam]); return; }
        const key = parseKey(prompt(`Pairing key for "${cam.name}" (from the camera's “Show key / QR”):`));
        if (!key) { alert('That pairing key is not valid.'); return; }
        saveCams(loadCams().filter((c) => c.code !== cam.code));
        addCamera(key, cam.name);
        renderCamList();
      };
      const rename = el('button', 'small secondary', '✏️');
      rename.title = 'Rename';
      rename.onclick = () => {
        const name = prompt('Camera name', cam.name);
        if (!name?.trim()) return;
        saveCams(loadCams().map((c) => (c.code === cam.code ? { ...c, name: name.trim().slice(0, 24) } : c)));
        renderCamList();
      };
      const remove = el('button', 'small secondary', '🗑');
      remove.title = 'Remove';
      remove.onclick = () => {
        if (!confirm(`Remove "${cam.name}"?`)) return;
        saveCams(loadCams().filter((c) => c.code !== cam.code));
        renderCamList();
      };
      row.append(info, watch, rename, remove);
      box.append(row);
    }
  }

  function startViewer() {
    show('viewer');
    renderCamList();
  }

  // One PeerJS connection for this phone, one session per camera being watched
  let viewPeer = null, lastAlert = 0;
  const sessions = new Map(); // camera peer id → session

  function startWatching(cams) {
    stopWatching();
    const name = myName();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    show('watching');
    keepAwake();
    for (const cam of cams.filter((c) => c.secret)) {
      const tile = el('div', 'card stack');
      const head = el('div', 'item');
      const unmute = el('button', 'small secondary', '🔈 Unmute');
      const full = el('button', 'small secondary', '⛶');
      head.append(el('div', 'grow name', cam.name), unmute, full);
      const video = el('video');
      video.autoplay = true; video.playsInline = true; video.muted = true;
      const meter = el('div', 'meter');
      const bar = el('div');
      meter.append(bar);
      const statusEl = el('div', 'status', 'Connecting…');
      tile.append(head, video, meter, statusEl);
      unmute.onclick = () => {
        video.muted = !video.muted;
        unmute.textContent = video.muted ? '🔈 Unmute' : '🔇 Mute';
        video.play().catch(() => {});
      };
      full.onclick = () => (video.requestFullscreen || video.webkitEnterFullscreen || video.webkitRequestFullscreen)?.call(video);
      $('tiles').append(tile);
      sessions.set(PREFIX + cam.code, {
        cam, name, video, statusEl, bar,
        conn: null, call: null, authed: false, T: null, stream: null, mine: null, theirs: null,
        live: false, denied: false, retryTimer: null, lostTimer: null, monitor: null,
      });
    }
    openViewPeer();
  }

  function openViewPeer() {
    viewPeer?.destroy();
    const peer = viewPeer = new Peer();
    peer.on('open', () => sessions.forEach((s) => dial(s)));
    peer.on('call', (call) => {
      const s = sessions.get(call.peer);
      // Only accept video from a camera that has proved it knows the secret
      if (!s || !s.authed) { call.close(); return; }
      s.call?.close();
      s.call = call; s.stream = null; s.mine = null;
      call.answer(); // receive only
      call.on('stream', (stream) => { s.stream = stream; checkCameraMedia(s); });
      call.on('close', () => { if (s.call === call) retry(s); });
      fingerprints(() => call.peerConnection)
        .then((fp) => {
          if (s.call !== call) return;
          s.mine = fp;
          s.conn?.send({ t: 'mfp', local: fp.local, remote: fp.remote });
          checkCameraMedia(s);
        })
        .catch(() => { if (s.call === call) retry(s); });
    });
    peer.on('error', (err) => {
      if (peer !== viewPeer) return;
      if (err.type === 'peer-unavailable') {
        // PeerJS puts the missing peer's id in the message
        for (const [id, s] of sessions) {
          if (String(err.message).includes(id)) {
            setStatus(s.statusEl, 'Camera not found — is it on? Retrying…', 'bad');
            retry(s, true);
          }
        }
      } else {
        sessions.forEach((s) => setStatus(s.statusEl, 'Problem: ' + err.type + ' — retrying…', 'bad'));
        setTimeout(() => peer === viewPeer && openViewPeer(), 4000);
      }
    });
    peer.on('disconnected', () => {
      setTimeout(() => peer === viewPeer && !peer.destroyed && peer.reconnect(), 2000);
    });
  }

  // Connect to the camera and prove we hold the pairing secret
  function dial(s) {
    if (!viewPeer || viewPeer.disconnected || !viewPeer.open) { retry(s, true); return; }
    s.authed = false; s.theirs = null;
    const conn = viewPeer.connect(PREFIX + s.cam.code, { reliable: true });
    s.conn = conn;
    const timer = setTimeout(() => { if (s.conn === conn && !s.authed) conn.close(); }, 20000);
    conn.on('data', async (msg) => {
      if (s.conn !== conn || !msg || typeof msg !== 'object') return;
      if (msg.t === 'hello' && isStr(msg.nc, 40) && !s.T) {
        let fps;
        try { fps = await fingerprints(() => conn.peerConnection); } catch { conn.close(); return; }
        const nv = nonce();
        s.T = transcript(msg.nc, nv, fps.remote, fps.local);
        conn.send({ t: 'auth', nv, name: s.name, mac: await sign(s.cam.secret, 'viewer|' + s.T) });
      } else if (msg.t === 'ok' && isStr(msg.mac, 100) && s.T && !s.authed) {
        if (await verify(s.cam.secret, 'camera|' + s.T, msg.mac)) {
          s.authed = true;
          clearTimeout(timer);
          setStatus(s.statusEl, '🔒 Verified — starting video…', 'ok');
        } else {
          setStatus(s.statusEl, '⚠️ This is not your camera (security check failed). Retrying…', 'bad');
          s.keepStatus = true;
          conn.close();
        }
      } else if (msg.t === 'deny') {
        s.denied = true;
        setStatus(s.statusEl, '🔑 The camera rejected this phone — its key was changed. Re-pair with the new key.', 'bad');
        conn.close();
      } else if (msg.t === 'mfp' && isFp(msg) && s.authed) {
        s.theirs = msg;
        checkCameraMedia(s);
      }
    });
    conn.on('close', () => { clearTimeout(timer); if (s.conn === conn) retry(s); });
    conn.on('error', () => conn.close());
  }

  // Show video only once both ends agree on the video link's encryption keys
  function checkCameraMedia(s) {
    if (!s.authed || !s.mine || !s.theirs || !s.stream || s.live) return;
    if (s.theirs.local !== s.mine.remote || s.theirs.remote !== s.mine.local) {
      setStatus(s.statusEl, '⚠️ Video security check failed — retrying…', 'bad');
      s.call?.close();
      return;
    }
    s.live = true;
    clearTimeout(s.lostTimer);
    s.video.srcObject = s.stream;
    s.video.play().catch(() => {});
    setStatus(s.statusEl, '🟢 Live · 🔒 end-to-end encrypted', 'ok');
    startMonitoring(s, s.stream);
  }

  function retry(s, keepStatus) {
    if (sessions.get(PREFIX + s.cam.code) !== s) return; // no longer watching
    stopMonitoring(s);
    const wasLive = s.live;
    s.live = false; s.authed = false; s.T = null;
    const call = s.call; s.call = null; call?.close();
    const conn = s.conn; s.conn = null; conn?.close();
    s.video.srcObject = null;
    if (s.denied) return; // wrong key: retrying won't help
    if (!keepStatus && !s.keepStatus) setStatus(s.statusEl, 'Connection lost — retrying…', 'bad');
    s.keepStatus = false;
    if (wasLive) {
      clearTimeout(s.lostTimer);
      s.lostTimer = setTimeout(() => !s.live && triggerAlert(`⚠️ Lost connection — ${s.cam.name}`), 15000);
    }
    clearTimeout(s.retryTimer);
    s.retryTimer = setTimeout(() => dial(s), 4000);
  }

  function stopWatching() {
    const old = [...sessions.values()];
    sessions.clear();
    for (const s of old) {
      clearTimeout(s.retryTimer); clearTimeout(s.lostTimer);
      stopMonitoring(s);
      s.call?.close(); s.conn?.close();
    }
    viewPeer?.destroy(); viewPeer = null;
    $('tiles').textContent = '';
    wakeLock?.release?.(); wakeLock = null;
  }

  // Sound + motion monitoring, done on the viewer phone (per camera)
  function startMonitoring(s, stream) {
    stopMonitoring(s);
    let audioCtx = null, analyser = null;
    if (stream.getAudioTracks().length) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
    }
    const buf = analyser ? new Uint8Array(analyser.fftSize) : null;
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 48;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let prev = null, loudFrames = 0, motionFrames = 0;

    const timer = setInterval(() => {
      const sens = +$('sensitivity').value; // 1..10
      if (analyser) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += (v - 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / buf.length) / 40);
        s.bar.style.width = (level * 100).toFixed(0) + '%';
        const threshold = 0.65 - sens * 0.05; // higher sensitivity → lower threshold
        loudFrames = level > threshold ? loudFrames + 1 : 0;
        if ($('noiseAlert').checked && loudFrames >= 4) triggerAlert(`🔊 Noise — ${s.cam.name}`);
      }
      if ($('motionAlert').checked && s.video.readyState >= 2) {
        ctx.drawImage(s.video, 0, 0, 64, 48);
        const data = ctx.getImageData(0, 0, 64, 48).data;
        if (prev) {
          let changed = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (Math.abs(data[i] - prev[i]) + Math.abs(data[i + 1] - prev[i + 1]) > 60) changed++;
          }
          const frac = changed / (64 * 48);
          motionFrames = frac > 0.12 - sens * 0.01 ? motionFrames + 1 : 0;
          if (motionFrames >= 2) triggerAlert(`🏃 Movement — ${s.cam.name}`);
        }
        prev = data;
      }
    }, 250);
    s.monitor = { timer, audioCtx };
  }

  function stopMonitoring(s) {
    if (!s.monitor) return;
    clearInterval(s.monitor.timer);
    s.monitor.audioCtx?.close();
    s.monitor = null;
    s.bar.style.width = '0';
  }

  function triggerAlert(msg) {
    const now = Date.now();
    if (now - lastAlert < 10000) return; // at most every 10s
    lastAlert = now;
    const box = $('alertBox');
    box.textContent = msg;
    box.classList.add('show');
    setTimeout(() => box.classList.remove('show'), 6000);
    navigator.vibrate?.([300, 150, 300]);
    beep();
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Nanny Cam', { body: msg });
    }
  }

  $('goViewer').onclick = startViewer;
  $('viewerHome').onclick = () => show('home');
  $('addCam').onclick = () => {
    const key = parseKey($('keyInput').value);
    if (!key) { alert('That pairing key is not valid. It is 34 letters and numbers, shown on the camera under “Show key / QR”.'); return; }
    addCamera(key, $('nameInput').value);
    $('keyInput').value = ''; $('nameInput').value = '';
    renderCamList();
  };
  $('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('addCam').click(); });
  $('myName').onclick = () => {
    const name = prompt("Name for this phone (the camera shows who's watching):", store.get('viewerName') || '');
    if (name?.trim()) store.set('viewerName', name.trim().slice(0, 24));
    renderCamList();
  };
  $('watchAll').onclick = () => startWatching(loadCams());
  $('stopWatching').onclick = () => { stopWatching(); startViewer(); };

  // Pairing links: …/#pair=KEY. The part after # never leaves this phone.
  const hash = location.hash;
  if (hash) history.replaceState(null, '', location.pathname);
  const pair = hash.match(/^#pair=([A-Za-z0-9-]{34,60})$/);
  if (pair) {
    const key = parseKey(pair[1]);
    if (key) {
      const known = loadCams().find((c) => c.code === key.code);
      const name = known ? known.name : prompt('Add this camera? Give it a name:', 'Camera ' + (loadCams().length + 1));
      if (name !== null) {
        startWatching([addCamera(key, name)]);
      } else startViewer();
    } else { alert('This pairing link is broken. Ask for a new one.'); startViewer(); }
  } else if (/^#watch=/.test(hash)) {
    alert('This is an old link. For security, ask for a new pairing link from the camera phone.');
    startViewer();
  }
})();
