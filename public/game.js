// ============================================================
//  Act Like NPC - Oyun görünümü (istemci)
//  Sunucudan gelen durumu çizer, girdileri gönderir.
//  Hiçbir oyun mantığı burada çalışmaz.
// ============================================================
window.GameView = (() => {
  const INTERP_DELAY = 100;   // ms: iki sunucu güncellemesi arasında yumuşak geçiş
  const DEFAULT_FADE_MS = 150;// ms: görünür alana girip çıkan karakterlerin belirme/kaybolma süresi
  const LONG_HIDE_GAP = 600;  // ms: uzun süre gizli kaldıktan sonra uzak noktada belirirse yumuşak çapa
  const SPARKLE_MS = 420;     // elmas alma parlamasının süresi

  const OUTFITS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c', '#e84393', '#636e72'];
  const SKINS = ['#f6d7b0', '#e8b98a', '#c68e5f', '#9c6b43', '#6b4a2f'];
  const HAT_COLORS = ['#2d3436', '#6c5ce7', '#d63031', '#8d6e63', '#2e7d32', '#ff7675'];

  // ---------- durum ----------
  let socket = null;
  let canvas, ctx, groundCanvas;
  let canopyCanvas = null;        // Önceden çizilmiş ağaç tepesi sprite'ı
  let roofCache = new Map();      // roofId -> önceden çizilmiş çatı yüzeyi canvas'ı
  let peekMaskCanvas = null;      // Yumuşak kenarlı delik maskesi (destination-out sprite)
  let peekRimCanvas = null;       // Yumuşak delik kenarı gölge halkası sprite'ı
  let charSpriteCache = new Map();// "outfit|hat|skin|dead|k" -> önbellekli karakter canvas'ı
  let running = false;
  let data = null;          // game:init verisi
  let map = null;
  let role = 'hider';
  let myCharId = null;
  let myId = null;          // kendi socket id'm
  let eliminated = false;
  let looks = new Map();    // id -> { outfit, hat, skin }
  let chars = new Map();    // id -> { buf: [{t,x,y,a}], flags, prog, lastSeen, last, visible, alpha }
  let firstStateReceived = false;
  let diamonds = [];        // [{ id, x, y }]
  let tasks = null;         // { stage, diamonds, diamondsNeeded, statue, vip, vipId }
  let statues = new Map();  // statueId -> { shape, color }
  let shots = [];           // { x, y, t0 }
  let puffs = [];           // { x, y, t0, dur } silinen NPC puf efektleri
  let sparkles = [];        // { x, y, t0 } elmas alınınca küçük parlama
  let punches = new Map();  // charId -> { t0, ang } VIP'ye vuran karakterin yumruk animasyonu
  let shakes = new Map();   // charId -> t0  vurulan VIP'nin sarsılması
  let flashUntil = 0;
  let lockUntil = 0;
  let lockTotal = 1;
  let lastCursorLocked = false;
  let lastGunKey = '';
  let lastScoreKey = '';
  let timeLeft = 0;
  let raf = null;
  let mouseTimer = null;
  let pingTimer = null;
  let lastMouseSent = '';
  let roofBuf = null;
  let view = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  let mouse = { x: 0, y: 0, inside: false };
  let input = { u: false, d: false, l: false, r: false };
  let scoreList = [];
  let overlayTimer = null;
  let lastTopBar = '';
  let lastPrompt = '';
  let phase = 'pick';         // 'pick' | 'play'
  let pickLeft = 10;
  let skill = null;           // { id, icon, name, usesLeft } (avcı için Q: Kalabalığı Azalt, saklanan için seçilen yetenek)
  let radarSkill = null;      // { id: 'radar', icon, name, cdUntil, cdTotal } (avcı için R: Radar Bombası)
  let radarAiming = false;    // avcı R'ye basıp haritada hedef seçiyor mu
  let skillMeta = new Map();  // skillId -> { id, icon, name, desc }
  let smokes = [];            // [{ id, x, y, leftMs, totalMs }]
  let radars = [];            // [{ id, x, y, landed, leftMs, totalMs, count }]
  let seekerVips = new Map(); // charId -> kalanCan (sadece avcıya gelen aktif VIP'ler)
  let hiderArrows = new Map();// charId -> colorHex (sadece saklananlara gelen ok renkleri; avcıda boş)
  let lastTickSoundSec = null;
  let lastSkillHudText = '';
  let lastRadarHudText = '';
  let lastRadarCdKey = '';
  let lastFrameAt = 0;

  // F3 performans göstergesi ölçümleri
  let perfVisible = false;
  let perfFps = 60;
  let perfPps = 20;
  let perfPingMs = 0;
  let perfLastPacketKb = 0;
  let perfDrawMs = 0;
  let perfFrameCount = 0;
  let perfFpsWindowStart = 0;
  let perfPacketCount = 0;
  let perfPpsWindowStart = 0;
  let perfLastDomUpdate = 0;

  const sfx = (name) => { if (window.SoundFX) window.SoundFX.play(name); };

  const $ = (id) => document.getElementById(id);
  const now = () => performance.now();
  const lerp = (a, b, t) => a + (b - a) * t;
  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }
  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // ============================================================
  //  KURULUM
  // ============================================================
  function init(sock) {
    socket = sock;
    canvas = $('game-canvas');
    ctx = canvas.getContext('2d');

    socket.on('game:state', onState);
    socket.on('game:shot', onShot);
    socket.on('game:notify', onNotify);
    socket.on('game:scores', onScores);
    socket.on('game:eliminated', onEliminated);
    socket.on('game:diamonds', (list) => { if (running) diamonds = list.map(([id, x, y]) => ({ id, x, y })); });
    socket.on('game:tasks', onTasks);
    socket.on('game:hint', ({ text }) => { if (running) { notice(text, 'warn'); sfx('notify'); } });
    socket.on('game:statue', ({ id, shape, color }) => { if (running) statues.set(id, { shape, color }); });
    socket.on('game:puffs', (list) => {
      if (!running || !Array.isArray(list)) return;
      const t0 = now();
      const dur = (data && data.skillsCfg && data.skillsCfg.puffTimeMs) || 450;
      for (const p of list) {
        chars.delete(p.id);
        puffs.push({ x: p.x, y: p.y, t0, dur });
      }
    });
    socket.on('game:sparkle', ({ x, y }) => { if (running) sparkles.push({ x, y, t0: now() }); });
    // VIP vuruşu: vuranda yumruk, VIP'de sarsılma (herkes görür; avcı sadece görebildiğini)
    socket.on('game:punch', ({ a, v, ang }) => {
      if (!running) return;
      const t0 = now();
      if (a !== null && a !== undefined) punches.set(a, { t0, ang: typeof ang === 'number' ? ang : null });
      if (v !== null && v !== undefined) shakes.set(v, t0);
    });
    socket.on('game:look', ([id, outfit, hat, skin]) => { if (running) looks.set(id, { outfit, hat, skin }); });
    socket.on('game:sfx', ({ name }) => { if (running) sfx(name); });
    socket.on('game:skillPicked', onSkillPicked);
    socket.on('game:skillState', onSkillState);
    socket.on('game:playStart', onPlayStart);
    socket.on('game:hiderArrows', (list) => {
      if (running && role === 'hider' && Array.isArray(list)) {
        hiderArrows = new Map(list.map(([id, hex]) => [id, hex]));
      }
    });

    $('skill-btn').addEventListener('click', activateSkill);
    if ($('radar-btn')) $('radar-btn').addEventListener('click', toggleRadarAim);

    window.addEventListener('resize', () => { if (running) resize(); });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', () => { if (running) setInput({ u: false, d: false, l: false, r: false }); });

    canvas.addEventListener('mousemove', (e) => {
      const p = toWorld(e.clientX, e.clientY);
      mouse.x = p.x; mouse.y = p.y; mouse.inside = true;
    });
    canvas.addEventListener('mouseleave', () => {
      mouse.inside = false;
      sendMousePos(true);
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!running || phase !== 'play' || role !== 'seeker') return;
      if (e.button === 2 && radarAiming) {
        radarAiming = false;
        renderSkillHud();
        return;
      }
      if (e.button !== 0) return;
      const p = toWorld(e.clientX, e.clientY);
      if (p.x < 0 || p.y < 0 || p.x > map.width || p.y > map.height) return;
      mouse.x = p.x; mouse.y = p.y; mouse.inside = true;
      sendMousePos(true);
      if (radarAiming) {
        radarAiming = false;
        if (radarSkill && now() >= (radarSkill.cdUntil || 0)) {
          socket.emit('game:useSkill', { skillId: 'radar', x: p.x, y: p.y });
        }
        renderSkillHud();
        return;
      }
      socket.emit('game:shoot', { x: p.x, y: p.y });
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function sendMousePos(force = false) {
    if (!running || role !== 'seeker' || phase !== 'play' || !map) return;
    const inMap = mouse.inside && mouse.x >= 0 && mouse.y >= 0 && mouse.x <= map.width && mouse.y <= map.height;
    const mx = Math.round(mouse.x);
    const my = Math.round(mouse.y);
    const key = inMap ? `${mx},${my}` : 'off';
    if (!force && key === lastMouseSent) return;
    lastMouseSent = key;
    socket.emit('game:mouse', inMap ? { x: mx, y: my } : null);
  }

  function measurePing() {
    if (!running || !socket) return;
    const t0 = now();
    socket.emit('game:ping', t0, () => {
      perfPingMs = Math.max(0, Math.round(now() - t0));
    });
  }

  function start(initData, socketId) {
    data = initData;
    myId = socketId || (socket && socket.id);
    map = data.map;
    role = data.role;
    myCharId = data.youCharId;
    eliminated = false;
    looks = new Map(data.appearances.map(([id, outfit, hat, skin]) => [id, { outfit, hat, skin }]));
    chars = new Map();
    firstStateReceived = false;
    diamonds = [];
    tasks = null;
    statues = new Map(Object.entries(data.statues || {}).map(([id, fig]) => [Number(id), fig]));
    shots = [];
    puffs = [];
    sparkles = [];
    punches = new Map();
    shakes = new Map();
    flashUntil = 0;
    lockUntil = 0;
    lastCursorLocked = false;
    lastGunKey = '';
    lastScoreKey = '';
    timeLeft = data.roundTime;
    input = { u: false, d: false, l: false, r: false };
    scoreList = [];
    lastTopBar = '';
    lastPrompt = '';
    phase = data.phase || 'pick';
    pickLeft = data.pickTime || 10;
    skillMeta = new Map((data.skillOptions || []).map((o) => [o.id, o]));
    if (data.assignedSkill) {
      const meta = skillMeta.get(data.assignedSkill.skillId) || { id: data.assignedSkill.skillId, icon: '🧹', name: data.assignedSkill.skillId };
      skill = { ...meta, usesLeft: data.assignedSkill.usesLeft, cdUntil: 0, cdTotal: 1 };
    } else {
      skill = null;
    }
    if (role === 'seeker') {
      const rMeta = skillMeta.get('radar') || { id: 'radar', icon: '📡', name: 'Radar Bombası' };
      const rCdMs = ((data.skillsCfg && data.skillsCfg.radarCooldown) || 15) * 1000;
      radarSkill = { ...rMeta, cdUntil: 0, cdTotal: rCdMs };
    } else {
      radarSkill = null;
    }
    radarAiming = false;
    smokes = [];
    radars = [];
    seekerVips = new Map();
    hiderArrows = role === 'hider' && Array.isArray(data.hiderArrows)
      ? new Map(data.hiderArrows.map(([id, hex]) => [id, hex]))
      : new Map();
    lastMouseSent = '';
    lastTickSoundSec = null;
    lastSkillHudText = '';
    lastRadarHudText = '';
    lastCdKey = '';
    lastRadarCdKey = '';
    lastFrameAt = now();
    perfFpsWindowStart = lastFrameAt;
    perfPpsWindowStart = lastFrameAt;
    perfFrameCount = 0;
    perfPacketCount = 0;
    $('notices').innerHTML = '';
    hideOverlay();
    running = true;

    clearInterval(mouseTimer);
    if (role === 'seeker') {
      const hz = data.mouseSendHz || 20;
      mouseTimer = setInterval(() => sendMousePos(false), Math.max(25, Math.round(1000 / hz)));
    }
    clearInterval(pingTimer);
    measurePing();
    pingTimer = setInterval(measurePing, 1000);

    renderRole();
    renderScores();
    renderTasks();
    renderSkillPick();
    renderSkillHud();
    resize();
    canvas.classList.toggle('seeker-cursor', role === 'seeker');
    canvas.classList.remove('gun-locked');
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    clearInterval(mouseTimer);
    mouseTimer = null;
    clearInterval(pingTimer);
    pingTimer = null;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    chars = new Map();
    shots = [];
    puffs = [];
    sparkles = [];
    smokes = [];
    radars = [];
    seekerVips = new Map();
    hiderArrows = new Map();
    radarAiming = false;
    canvas.classList.remove('seeker-cursor', 'gun-locked');
    $('notices').innerHTML = '';
    $('skill-pick').hidden = true;
    $('skill-btn').hidden = true;
    if ($('radar-btn')) $('radar-btn').hidden = true;
    hideOverlay();
  }

  // ============================================================
  //  AĞ OLAYLARI
  // ============================================================
  function onState(st) {
    if (!running) return;
    const t = now();

    // Performans ölçümü: paket boyutu (KB) ve saniyedeki paket sayısı
    perfPacketCount++;
    try {
      perfLastPacketKb = JSON.stringify(st).length / 1024;
    } catch { /* yok say */ }
    if (t - perfPpsWindowStart >= 1000) {
      perfPps = Math.round((perfPacketCount * 1000) / Math.max(1, t - perfPpsWindowStart));
      perfPacketCount = 0;
      perfPpsWindowStart = t;
    }

    if (st.looks) {
      for (const [id, outfit, hat, skin] of st.looks) looks.set(id, { outfit, hat, skin });
    }

    const seenInPacket = new Set();
    // Kısa dizi: [id, x, y, açıDerece, bayraklar?, ilerleme%?] (0 bayrak / halka yoksa eleman yok)
    for (const [id, x, y, deg, flags, pct] of st.c) {
      seenInPacket.add(id);
      const a = (deg * Math.PI) / 180;
      let c = chars.get(id);
      if (!c) {
        c = {
          buf: [],
          flags: 0,
          prog: -1,
          lastSeen: t,
          last: { x, y },
          visible: true,
          alpha: firstStateReceived ? 0 : 1,
        };
        chars.set(id, c);
      } else if (c.buf.length > 0) {
        // Geçmiş konumlar silinmez; eğer karakter uzun süre (>600 ms) gizli kalıp uzağa yürüdüyse
        // 100 ms öncesine yakın bir geçiş çapası eklenir ki haritayı boydan boya uçmasın
        const prev = c.buf[c.buf.length - 1];
        if (t - prev.t > LONG_HIDE_GAP && Math.hypot(x - prev.x, y - prev.y) > 45) {
          c.buf.push({
            t: t - INTERP_DELAY,
            x: x - Math.cos(a) * 3,
            y: y - Math.sin(a) * 3,
            a,
          });
        }
      }
      c.buf.push({ t, x, y, a });
      if (c.buf.length > 20) c.buf.shift();
      c.flags = flags || 0;
      c.prog = pct === undefined ? -1 : pct / 100;
      c.lastSeen = t;
      c.last = { x, y };
      c.visible = true;
    }
    for (const [id, c] of chars) {
      if (!seenInPacket.has(id)) c.visible = false;
    }
    firstStateReceived = true;

    if (typeof st.g === 'number') {
      if (st.g > 0) {
        const until = t + st.g;
        if (until > lockUntil + 40) { lockUntil = until; lockTotal = st.g; }
      } else lockUntil = 0;
    }
    smokes = (st.sm || []).map(([id, x, y, leftMs, totalMs]) => ({ id, x, y, leftMs, totalMs }));
    radars = (st.rb || []).map(([id, x, y, landed, leftMs, totalMs, count]) => ({
      id,
      x,
      y,
      landed: !!landed,
      leftMs,
      totalMs,
      count: typeof count === 'number' ? count : null,
    }));
    if (role === 'seeker') {
      seekerVips = new Map((st.vips || []).map(([id, hp]) => [id, hp]));
    } else {
      seekerVips.clear();
    }

    if (typeof st.phase === 'string') {
      phase = st.phase;
      if (phase === 'pick' && typeof st.pickLeft === 'number') {
        if (pickLeft !== st.pickLeft) {
          pickLeft = st.pickLeft;
          $('pick-timer').textContent = `⏱ ${pickLeft}`;
        }
      }
      if (phase === 'play' && !$('skill-pick').hidden) {
        $('skill-pick').hidden = true;
      }
    }

    if (typeof st.left === 'number' && st.left !== timeLeft) {
      timeLeft = st.left;
      if (phase === 'play' && timeLeft <= 10 && timeLeft > 0 && timeLeft !== lastTickSoundSec) {
        lastTickSoundSec = timeLeft;
        sfx('tick');
      }
      renderTopBar();
    }
  }

  function onShot({ x, y }) {
    if (!running) return;
    const t = now();
    shots.push({ x, y, t0: t });
    flashUntil = t + 90;
    sfx('shoot');
  }

  function onNotify({ kind, text, sfx: sfxName }) {
    if (!running) return;
    let tone = 'warn';
    if (kind === 'caught') tone = role === 'seeker' ? 'good' : 'bad';
    else if (kind === 'npc') tone = role === 'seeker' ? 'bad' : 'good';
    else if (kind === 'good' || kind === 'bad' || kind === 'warn') tone = kind;
    notice(text, tone);
    if (sfxName) sfx(sfxName);
    else if (kind === 'caught') sfx('caught');
    else if (kind === 'npc') sfx('npcHit');
    else sfx('notify');
  }

  function onSkillPicked({ skillId, usesLeft }) {
    const meta = skillMeta.get(skillId) || { id: skillId, icon: '✨', name: skillId };
    skill = { ...meta, usesLeft, cdUntil: 0, cdTotal: 1 };
    if (role !== 'seeker') {
      const cards = $('skill-cards').querySelectorAll('.skill-card');
      for (const card of cards) {
        card.classList.toggle('selected', card.dataset.id === skillId);
        card.disabled = true;
      }
      $('pick-sub').textContent = `${meta.icon} ${meta.name} seçildi! Diğer oyuncular bekleniyor...`;
    }
    renderSkillHud();
  }

  function onSkillState({ skillId, usesLeft, cooldownMs, cooldownTotalMs }) {
    if (skillId === 'radar' && radarSkill) {
      if (typeof cooldownMs === 'number') {
        radarSkill.cdUntil = now() + cooldownMs;
        radarSkill.cdTotal = Math.max(1, cooldownTotalMs || cooldownMs);
      }
      radarAiming = false;
      renderSkillHud();
      return;
    }
    if (!skill || skill.id !== skillId) {
      const meta = skillMeta.get(skillId) || { id: skillId, icon: '✨', name: skillId };
      skill = { ...meta, usesLeft: 0, cdUntil: 0, cdTotal: 1 };
    }
    if (typeof usesLeft === 'number' || usesLeft === null) skill.usesLeft = usesLeft;
    if (typeof cooldownMs === 'number') {
      skill.cdUntil = now() + cooldownMs;
      skill.cdTotal = Math.max(1, cooldownTotalMs || cooldownMs);
    }
    renderSkillHud();
  }

  function onPlayStart({ roundTime }) {
    if (!running) return;
    phase = 'play';
    if (typeof roundTime === 'number') timeLeft = roundTime;
    $('skill-pick').hidden = true;
    sendMousePos(true);
    renderTopBar();
    renderSkillHud();
    sfx('roundStart');
  }

  function onScores(list) {
    scoreList = list;
    if (running) { renderScores(); renderTopBar(); }
  }

  function onEliminated() {
    eliminated = true;
    setInput({ u: false, d: false, l: false, r: false });
    renderRole();
    renderTasks();
    renderSkillHud();
  }

  function onTasks(t) {
    if (!running) return;
    tasks = t;
    renderTasks();
  }

  // ============================================================
  //  GİRDİ
  // ============================================================
  const KEYS = {
    KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd',
    KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r',
  };
  function onKey(e) {
    if (e.code === 'F3') {
      e.preventDefault();
      if (e.type === 'keydown' && !e.repeat) {
        perfVisible = !perfVisible;
        if ($('perf-hud')) $('perf-hud').hidden = !perfVisible;
        renderPerfHud(true);
      }
      return;
    }
    if (!running) return;
    if (phase !== 'play') return;
    if (e.code === 'KeyQ') {
      if (e.type === 'keydown' && !e.repeat) activateSkill();
      return;
    }
    if (e.code === 'KeyR') {
      if (e.type === 'keydown' && !e.repeat && role === 'seeker') toggleRadarAim();
      return;
    }
    if (e.code === 'Escape') {
      if (e.type === 'keydown' && radarAiming) {
        radarAiming = false;
        renderSkillHud();
      }
      return;
    }
    if (e.code === 'KeyE') {
      if (e.type === 'keydown' && !e.repeat && role === 'hider' && !eliminated) socket.emit('game:interact');
      return;
    }
    const k = KEYS[e.code];
    if (!k) return;
    if (e.code.startsWith('Arrow')) e.preventDefault();
    if (role !== 'hider' || eliminated) return;
    const next = { ...input, [k]: e.type === 'keydown' };
    if (next[k] !== input[k]) setInput(next);
  }

  function toggleRadarAim() {
    if (!running || phase !== 'play' || role !== 'seeker' || !radarSkill) return;
    if (now() < (radarSkill.cdUntil || 0)) return;
    radarAiming = !radarAiming;
    renderSkillHud();
  }

  function activateSkill() {
    if (!running || phase !== 'play' || !skill) return;
    if (role === 'hider') {
      if (eliminated) return;
      if (skill.usesLeft !== null && skill.usesLeft <= 0) return; // sis bombasında hak sınırı yok (null)
      if (now() < (skill.cdUntil || 0)) return;                    // yeniden doluyor
      socket.emit('game:useSkill');
      return;
    }
    const unlockLeft = (data && data.skillsCfg && data.skillsCfg.cullUnlockLeft) || 90;
    if (skill.usesLeft <= 0 || timeLeft > unlockLeft) return;
    socket.emit('game:useSkill');
  }
  function setInput(next) {
    input = next;
    socket.emit('game:input', input);
  }

  function toWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - view.ox) / view.scale,
      y: (clientY - rect.top - view.oy) / view.scale,
    };
  }

  // ============================================================
  //  ARAYÜZ (DOM)
  // ============================================================
  function renderRole() {
    const badge = $('role-badge');
    const hint = $('role-hint');
    $('gun-panel').hidden = role !== 'seeker';
    $('spectator-note').hidden = !(role === 'hider' && eliminated);
    if (role === 'seeker') {
      badge.textContent = '🔫 AVCI';
      badge.className = 'role-badge seeker';
      hint.textContent = 'Tıkla: ateş · Q: Kalabalığı Azalt · R: Radar Bombası. Aktif VIP (👑) vurmak −10 puan!';
    } else if (eliminated) {
      badge.textContent = '👻 İZLEYİCİ';
      badge.className = 'role-badge out';
      hint.textContent = 'Yakalandın. Puanların sende kalır, turun bitmesini bekle.';
    } else {
      badge.textContent = '🕵️ SAKLANAN';
      badge.className = 'role-badge hider';
      hint.textContent = 'WASD / oklar: yürü · E: görev · Q: yetenek. NPC gibi davran!';
    }
  }

  function renderSkillPick() {
    const box = $('skill-pick');
    if (phase !== 'pick' || !data || !data.skillOptions) {
      box.hidden = true;
      return;
    }
    const pill = $('pick-role-pill');
    pill.textContent = role === 'seeker' ? '🔫 AVCI' : '🕵️ SAKLANAN';
    pill.className = `pick-role-pill ${role}`;
    $('pick-timer').textContent = `⏱ ${pickLeft}`;
    // Turdan önce: "Tur 2/5 · Avcı: Ayşe"
    $('pick-round').textContent = `Tur ${data.round}/${data.totalRounds} · Avcı: ${data.seekerName}`;

    const cards = $('skill-cards');
    cards.innerHTML = '';

    if (role === 'seeker') {
      $('pick-title').textContent = 'Senin Yeteneklerin';
      $('pick-sub').textContent = 'Yetenek seçimi yok, ikisi de her zaman sende. Saklananlar seçim yapıyor...';
      cards.classList.toggle('single', data.skillOptions.length === 1);

      for (const opt of data.skillOptions) {
        const card = document.createElement('div');
        card.className = 'skill-card info-only';
        const icon = document.createElement('span');
        icon.className = 'skill-card-icon';
        icon.textContent = opt.icon;
        const name = document.createElement('strong');
        name.className = 'skill-card-name';
        name.textContent = `${opt.icon} ${opt.name}${opt.key ? ` (${opt.key})` : ''}`;
        const desc = document.createElement('span');
        desc.className = 'skill-card-desc';
        desc.textContent = opt.desc;
        card.append(icon, name, desc);
        cards.append(card);
      }
      box.hidden = false;
      return;
    }

    $('pick-title').textContent = 'Yeteneğini Seç';
    $('pick-sub').textContent = 'Kimse başkasının yeteneğini görmez. Süre bitince rastgele verilir.';
    cards.classList.remove('single');

    for (const opt of data.skillOptions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'skill-card';
      btn.dataset.id = opt.id;
      const icon = document.createElement('span');
      icon.className = 'skill-card-icon';
      icon.textContent = opt.icon;
      const name = document.createElement('strong');
      name.className = 'skill-card-name';
      name.textContent = opt.name;
      const desc = document.createElement('span');
      desc.className = 'skill-card-desc';
      desc.textContent = opt.desc;
      btn.append(icon, name, desc);
      btn.addEventListener('click', () => socket.emit('game:pickSkill', { skillId: opt.id }));
      cards.append(btn);
    }
    box.hidden = false;
  }

  function renderSkillHud() {
    const btn = $('skill-btn');
    if (!skill || (role === 'hider' && eliminated)) {
      if (lastSkillHudText !== 'hidden') {
        lastSkillHudText = 'hidden';
        btn.hidden = true;
      }
      renderRadarHud();
      return;
    }

    let status = '';
    let disabled = phase !== 'play';
    let readySeeker = false;
    if (role === 'seeker') {
      const unlockLeft = (data && data.skillsCfg && data.skillsCfg.cullUnlockLeft) || 90;
      if (skill.usesLeft <= 0) {
        status = 'Kullanıldı';
        disabled = true;
      } else if (phase !== 'play' || timeLeft > unlockLeft) {
        status = `${fmtTime(unlockLeft)}'da açılır`;
        disabled = true;
      } else {
        status = 'Hazır · Q veya tıkla';
        disabled = false;
        readySeeker = true;
      }
    } else if (skill.usesLeft === null) {
      // Sis bombası: hak sınırı yok, atıldıktan sonra yeniden dolar
      const cdLeft = Math.max(0, (skill.cdUntil || 0) - now());
      if (cdLeft > 0) {
        status = `Yeniden doluyor · ${Math.ceil(cdLeft / 1000)} sn`;
        disabled = true;
      } else {
        status = phase === 'pick' ? 'Hazırlanıyor' : 'Hazır · Q veya tıkla';
      }
    } else {
      if (skill.usesLeft <= 0) {
        status = 'Kullanım hakkı bitti';
        disabled = true;
      } else {
        status = phase === 'pick' ? `${skill.usesLeft} hak (hazırlanıyor)` : `Kalan hak: ${skill.usesLeft}`;
      }
    }
    const key = `${skill.id}|${skill.icon}|${skill.name}|${status}|${disabled}|${readySeeker}`;
    if (key !== lastSkillHudText) {
      lastSkillHudText = key;
      btn.hidden = false;
      $('skill-icon').textContent = skill.icon;
      $('skill-name').textContent = skill.name;
      $('skill-status').textContent = status;
      btn.disabled = disabled;
      btn.classList.toggle('ready-seeker', readySeeker);
    }
    renderSkillCooldown();
    renderRadarHud();
  }

  function renderRadarHud() {
    const rBtn = $('radar-btn');
    if (!rBtn) return;
    if (role !== 'seeker' || !radarSkill) {
      if (lastRadarHudText !== 'hidden') {
        lastRadarHudText = 'hidden';
        rBtn.hidden = true;
      }
      return;
    }

    const cdLeft = Math.max(0, (radarSkill.cdUntil || 0) - now());
    let status = '';
    let disabled = phase !== 'play';
    let aiming = false;
    let readySeeker = false;

    if (phase !== 'play') {
      status = 'Hazırlanıyor';
      disabled = true;
    } else if (cdLeft > 0) {
      status = `Yeniden doluyor · ${Math.ceil(cdLeft / 1000)} sn`;
      disabled = true;
    } else if (radarAiming) {
      status = 'Haritada bir yere tıkla (İptal: R)';
      disabled = false;
      aiming = true;
    } else {
      status = 'Hazır · R veya tıkla';
      disabled = false;
      readySeeker = true;
    }

    const icon = radarSkill.icon || '📡';
    const name = radarSkill.name || 'Radar Bombası';
    const rKey = `${icon}|${name}|${status}|${disabled}|${aiming}|${readySeeker}`;
    if (rKey !== lastRadarHudText) {
      lastRadarHudText = rKey;
      rBtn.hidden = false;
      $('radar-icon').textContent = icon;
      $('radar-name').textContent = name;
      $('radar-status').textContent = status;
      rBtn.disabled = disabled;
      rBtn.classList.toggle('aiming', aiming);
      rBtn.classList.toggle('ready-seeker', readySeeker);
    }
    renderRadarCooldown(cdLeft);
  }

  function renderRadarCooldown(left) {
    const cd = $('radar-cd');
    if (!cd) return;
    if (left <= 0 || !radarSkill) {
      if (lastRadarCdKey !== 'off') { lastRadarCdKey = 'off'; cd.hidden = true; }
      return;
    }
    const p = Math.max(0, Math.min(1, 1 - left / radarSkill.cdTotal));
    const sec = Math.ceil(left / 1000);
    const key = `${Math.round(p * 200)}|${sec}`;
    if (key === lastRadarCdKey) return;
    lastRadarCdKey = key;
    cd.hidden = false;
    cd.style.setProperty('--p', p.toFixed(3));
    $('radar-cd-text').textContent = sec;
  }

  // Butonun üstünde dolan halka + geri sayım (her karede güncellenir)
  let lastCdKey = '';
  function renderSkillCooldown() {
    const cd = $('skill-cd');
    const left = skill ? Math.max(0, (skill.cdUntil || 0) - now()) : 0;
    if (left <= 0) {
      if (lastCdKey !== 'off') { lastCdKey = 'off'; cd.hidden = true; }
      return;
    }
    const p = Math.max(0, Math.min(1, 1 - left / skill.cdTotal));
    const sec = Math.ceil(left / 1000);
    const key = `${Math.round(p * 200)}|${sec}`;
    if (key === lastCdKey) return;
    lastCdKey = key;
    cd.hidden = false;
    cd.style.setProperty('--p', p.toFixed(3));
    $('skill-cd-text').textContent = sec;
  }

  function renderScores() {
    const key = scoreList.map((p) => `${p.id}:${p.role}:${p.out ? 1 : 0}:${p.score}`).join('|');
    if (key === lastScoreKey) return;
    lastScoreKey = key;
    const ul = $('score-list');
    ul.innerHTML = '';
    for (const p of scoreList) {
      const li = document.createElement('li');
      if (p.out) li.classList.add('out');
      if (p.id === myId) li.classList.add('me');
      const name = document.createElement('span');
      name.className = 'score-name';
      name.textContent = (p.role === 'seeker' ? '🔫 ' : p.out ? '💀 ' : '🕵️ ') + p.name;
      const score = document.createElement('span');
      score.className = 'score-value';
      score.textContent = p.score;
      li.append(name, score);
      ul.append(li);
    }
  }

  function renderTopBar() {
    if (!data) return;
    const hiders = scoreList.filter((p) => p.role === 'hider');
    const alive = hiders.filter((p) => !p.out).length;
    const low = timeLeft <= 30 ? ' low' : '';
    const html = `Tur ${data.round}/${data.totalRounds} · Avcı: ${escapeHtml(data.seekerName)} · ` +
      `<span class="${low.trim()}">⏱ ${fmtTime(timeLeft)}</span> · Kalan saklanan: ${alive}/${hiders.length}`;
    if (html !== lastTopBar) { $('top-bar').innerHTML = html; lastTopBar = html; }
  }

  function renderGun() {
    const t = now();
    const locked = t < lockUntil;
    if (locked !== lastCursorLocked) {
      lastCursorLocked = locked;
      if (canvas) canvas.classList.toggle('gun-locked', role === 'seeker' && locked);
    }
    const pct = locked ? Math.round(Math.max(0, Math.min(1, 1 - (lockUntil - t) / lockTotal)) * 100) : 100;
    const txt = locked ? `${((lockUntil - t) / 1000).toFixed(1)} sn` : 'Hazır';
    const key = `${locked ? 1 : 0}|${pct}|${txt}`;
    if (key === lastGunKey) return;
    lastGunKey = key;
    const panel = $('gun-panel');
    panel.classList.toggle('locked', locked);
    $('gun-fill').style.width = `${pct}%`;
    $('gun-text').textContent = txt;
  }

  function renderPerfHud(force = false) {
    if (!perfVisible) return;
    const t = now();
    if (!force && t - perfLastDomUpdate < 200) return;
    perfLastDomUpdate = t;
    const fpsEl = $('perf-fps');
    if (!fpsEl) return;
    fpsEl.textContent = String(perfFps);
    $('perf-pps').textContent = String(perfPps);
    $('perf-ping').textContent = `${perfPingMs} ms`;
    $('perf-size').textContent = `${perfLastPacketKb.toFixed(2)} KB`;
    $('perf-draw').textContent = `${perfDrawMs.toFixed(2)} ms`;
  }

  function renderTasks() {
    const panel = $('task-panel');
    if (role !== 'hider' || eliminated || !tasks) { panel.hidden = true; return; }
    panel.hidden = false;
    const ul = $('task-list');
    ul.innerHTML = '';
    const pts = data.points || {};
    const items = [
      { key: 'diamonds', label: `💎 Elmas topla (${tasks.diamonds}/${tasks.diamondsNeeded})`, pts: `+${pts.diamond} / elmas`, done: tasks.diamonds >= tasks.diamondsNeeded },
      { key: 'statue', label: '🗿 Heykeli incele', pts: `+${pts.statue}`, done: tasks.statue },
      { key: 'vip', label: `🎯 VIP ${tasks.vipHits || 0}/${tasks.vipHitsNeeded || 3}`, pts: `+${pts.vip}`, done: tasks.vip },
    ];
    for (const it of items) {
      const li = document.createElement('li');
      if (it.done) li.classList.add('done');
      else if (it.key === tasks.stage) li.classList.add('current');
      else li.classList.add('locked');
      const a = document.createElement('span'); a.textContent = it.label;
      const b = document.createElement('span'); b.textContent = it.pts;
      li.append(a, b);
      ul.append(li);
    }
  }

  // Bir görevin yanındaysa "E'ye bas" ipucu (sunucudan bağımsız, sadece görsel)
  function updatePrompt() {
    let text = '';
    const me = myCharId && chars.get(myCharId);
    if (tasks && me && me.last && role === 'hider' && !eliminated) {
      const range = data.interactRange || 40;
      const { x, y } = me.last;
      if (tasks.stage === 'diamonds') {
        const near = diamonds.some((d) => Math.hypot(d.x - x, d.y - y) <= range);
        if (near) text = 'E\'ye bas: 💎 Elması al';
      } else if (tasks.stage === 'statue') {
        const near = (map.statues || []).some((st) => Math.hypot(st.x - x, st.y - y) <= st.r + range);
        if (near) text = 'E\'ye bas: 🗿 Heykeli incele';
      } else if (tasks.stage === 'vip' && tasks.vipId) {
        const v = chars.get(tasks.vipId);
        const hitRange = data.vipHitRange || 30;
        if (v && v.last && !(v.flags & 2) && Math.hypot(v.last.x - x, v.last.y - y) <= hitRange) {
          text = `E'ye bas: 👊 VIP'ye vur (${tasks.vipHits || 0}/${tasks.vipHitsNeeded || 3})`;
        }
      }
    }
    if (text !== lastPrompt) {
      lastPrompt = text;
      const el = $('task-prompt');
      el.textContent = text;
      el.hidden = !text;
    }
  }

  function notice(text, tone) {
    const box = $('notices');
    const n = document.createElement('div');
    n.className = `notice notice-${tone}`;
    n.textContent = text;
    box.append(n);
    setTimeout(() => n.classList.add('fade'), 1600);
    setTimeout(() => n.remove(), 2000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- tur sonu / final ekranları ----------
  function hideOverlay() {
    clearInterval(overlayTimer);
    overlayTimer = null;
    $('overlay').hidden = true;
  }

  function countdown(seconds, fmt) {
    const foot = $('overlay-foot');
    let left = Math.round(seconds);
    foot.textContent = fmt(left);
    clearInterval(overlayTimer);
    overlayTimer = setInterval(() => {
      left--;
      if (left <= 0) { clearInterval(overlayTimer); overlayTimer = null; }
      foot.textContent = fmt(Math.max(0, left));
    }, 1000);
  }

  function showRoundEnd(d) {
    running = false;               // çizim donar, tablo üstte görünür
    clearInterval(mouseTimer);
    mouseTimer = null;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    $('skill-pick').hidden = true;
    $('task-prompt').hidden = true;
    if ($('overlay-card')) $('overlay-card').classList.remove('leaderboard-card');
    if ($('overlay-actions')) $('overlay-actions').hidden = true;
    $('overlay-title').textContent = d.reasonText;
    $('overlay-sub').textContent = `Tur ${d.round}/${d.totalRounds} bitti`;
    const table = $('overlay-table');
    table.innerHTML = '';
    const head = table.insertRow();
    for (const h of ['Oyuncu', 'Görevler', 'Bu tur', 'Toplam']) {
      const th = document.createElement('th'); th.textContent = h; head.append(th);
    }
    const rows = [...d.players].sort((a, b) => b.roundScore - a.roundScore);
    for (const p of rows) {
      const tr = table.insertRow();
      if (p.id === myId) tr.classList.add('me');
      const icon = p.role === 'seeker' ? '🔫' : p.alive ? '🕵️' : '💀';
      tr.insertCell().textContent = `${icon} ${p.name}`;
      let taskText = '—';
      if (p.role === 'hider' && p.tasks) {
        taskText = `💎 ${p.tasks.diamonds}/${p.tasks.diamondsNeeded} · 🗿 ${p.tasks.statue ? '✔' : '✖'} · 🎯 ${p.tasks.vip ? '✔' : '✖'}`;
      }
      tr.insertCell().textContent = taskText;
      const rc = tr.insertCell();
      rc.className = 'num ' + (p.roundScore > 0 ? 'plus' : p.roundScore < 0 ? 'minus' : '');
      rc.textContent = (p.roundScore > 0 ? '+' : '') + p.roundScore;
      const tc = tr.insertCell(); tc.className = 'num'; tc.textContent = p.score;
    }
    $('overlay').hidden = false;
    const last = d.round >= d.totalRounds;
    const nextInfo = d.next ? `Sıradaki: Tur ${d.next.round}/${d.next.totalRounds} · Avcı: ${d.next.seekerName} · ` : 'Sonraki tur ';
    countdown(d.seconds || 7, (s) => (last ? `Liderlik tablosu ${s} sn içinde` : `${nextInfo}${s} sn içinde başlıyor...`));
  }

  function showFinal(d) {
    running = false;
    clearInterval(mouseTimer);
    mouseTimer = null;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    $('skill-pick').hidden = true;
    if ($('overlay-card')) $('overlay-card').classList.add('leaderboard-card');
    if ($('overlay-actions')) $('overlay-actions').hidden = false;
    sfx('final');
    $('overlay-title').textContent = '🏆 Liderlik Tablosu';
    const winners = (d.players || []).filter((p) => p.rank === 1);
    $('overlay-sub').textContent = winners.length
      ? `${winners.length > 1 ? 'Kazananlar' : 'Kazanan'}: ${winners.map((w) => w.name).join(', ')}`
      : '';
    const table = $('overlay-table');
    table.innerHTML = '';
    const head = table.insertRow();
    for (const h of ['Sıra', 'Oyuncu ve İstatistikler', 'Toplam']) {
      const th = document.createElement('th'); th.textContent = h; head.append(th);
    }
    const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };
    (d.players || []).forEach((p, idx) => {
      const tr = table.insertRow();
      if (p.rank === 1) tr.classList.add('winner');
      if (idx === 0 || p.rank === 1) tr.classList.add('first-row');
      if (p.id === myId) tr.classList.add('me');

      const rankCell = tr.insertCell();
      rankCell.className = 'lb-rank';
      const medal = MEDALS[p.rank] || '';
      rankCell.textContent = medal ? `${medal} ${p.rank}` : String(p.rank);

      const playerCell = tr.insertCell();
      const wrap = document.createElement('div');
      wrap.className = 'lb-player';
      const nameEl = document.createElement('span');
      nameEl.className = 'lb-name';
      nameEl.textContent = p.name;
      const statsEl = document.createElement('div');
      statsEl.className = 'lb-stats';
      const st = p.stats || {};
      const seekerLine = document.createElement('span');
      seekerLine.textContent = `🔫 Avcıyken: ${st.caughtPlayers || 0} yakalama · ${st.hitNpcs || 0} masum NPC · ${st.hitVips || 0} VIP`;
      const hiderLine = document.createElement('span');
      hiderLine.textContent = `🕵️ Saklanırken: 💎 ${st.diamonds || 0} elmas · 🗿 ${st.statues || 0} heykel · 🎯 ${st.vipsKilled || 0} VIP · ⏱ ${st.survivedRounds || 0} tur hayatta`;
      statsEl.append(seekerLine, hiderLine);
      wrap.append(nameEl, statsEl);
      playerCell.append(wrap);

      const c = tr.insertCell();
      c.className = 'num';
      c.textContent = p.score;
    });
    $('overlay').hidden = false;
    countdown(d.seconds || 15, (s) => `Lobiye dönülüyor... ${s} sn`);
  }

  // ============================================================
  //  ÇİZİM
  // ============================================================
  // Offscreen canvas boyutu: sonlu bir sayı ve en az 1 piksel olmalı (0 / NaN / Infinity asla)
  function safeDim(v) {
    return Number.isFinite(v) && v >= 1 ? Math.ceil(v) : 1;
  }
  // drawImage'a verilecek canvas çizilebilir mi? (genişlik ve yükseklik >= 1)
  function canDraw(c) {
    return !!c && c.width >= 1 && c.height >= 1;
  }
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = safeDim(w);
    c.height = safeDim(h);
    return c;
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    // Pencere küçültülmüş / henüz yerleşmemişse 0 gelebilir: en az 1 piksel kullan
    const w = Math.max(1, canvas.clientWidth || window.innerWidth || 1);
    const h = Math.max(1, canvas.clientHeight || window.innerHeight || 1);
    canvas.width = safeDim(Math.round(w * dpr));
    canvas.height = safeDim(Math.round(h * dpr));
    let scale = Math.min(w / map.width, h / map.height);
    if (!Number.isFinite(scale) || scale <= 0) scale = (view && view.scale) || 1;
    view = { scale, dpr, ox: (w - map.width * scale) / 2, oy: (h - map.height * scale) / 2 };
    buildGround();
  }

  // Zemin, yollar, meydan, ağaç gövdeleri, direkler, çeşme tabanı, heykel kaideleri,
  // çatı yüzeyleri ve yumuşak delik sprite'ları oyun başında / boyut değişiminde BİR KEZ çizilir.
  function buildGround() {
    const k = view.scale * view.dpr;
    charSpriteCache.clear();
    roofCache.clear();
    roofBuf = null; // Yeni ölçekte yeniden oluşturulsun

    groundCanvas = makeCanvas(map.width * k, map.height * k);
    const g = groundCanvas.getContext('2d');
    g.scale(k, k);

    const gr = map.ground;
    g.fillStyle = gr.base;
    g.fillRect(0, 0, map.width, map.height);
    const T = gr.tile;
    for (let y = 0; y < map.height; y += T) {
      for (let x = 0; x < map.width; x += T) {
        if (((x / T) + (y / T)) % 2 === 0) continue;
        g.fillStyle = gr.alt;
        g.fillRect(x, y, T, T);
      }
    }
    g.strokeStyle = gr.grout;
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= map.width; x += T) { g.moveTo(x, 0); g.lineTo(x, map.height); }
    for (let y = 0; y <= map.height; y += T) { g.moveTo(0, y); g.lineTo(map.width, y); }
    g.stroke();

    for (const p of map.paths) {
      g.fillStyle = map.pathEdge;
      g.fillRect(p.x - 3, p.y - 3, p.w + 6, p.h + 6);
      g.fillStyle = map.pathColor;
      g.fillRect(p.x, p.y, p.w, p.h);
    }

    if (map.plaza) {
      g.beginPath();
      g.arc(map.plaza.x, map.plaza.y, map.plaza.r, 0, Math.PI * 2);
      g.fillStyle = map.pathColor;
      g.fill();
      g.lineWidth = 6;
      g.strokeStyle = map.pathEdge;
      g.stroke();
      g.beginPath();
      g.arc(map.plaza.x, map.plaza.y, map.plaza.r * 0.6, 0, Math.PI * 2);
      g.lineWidth = 2;
      g.stroke();
    }

    for (const r of map.roofs) {
      g.fillStyle = r.accent;
      g.globalAlpha = 0.35;
      g.fillRect(r.x, r.y, r.w, r.h);
      g.globalAlpha = 1;
    }

    // Banklar, ağaç gövdeleri ve çatı direkleri (sabit: doğrudan zemin canvas'ına çizilir)
    for (const o of map.obstacles) {
      if (o.kind === 'bench') {
        g.fillStyle = '#7a5230';
        g.fillRect(o.x, o.y, o.w, o.h);
        g.fillStyle = '#9c6b43';
        g.fillRect(o.x + 2, o.y + 2, o.w - 4, o.h - 4);
      } else if (o.kind === 'tree') {
        g.fillStyle = 'rgba(0,0,0,0.18)';
        g.beginPath(); g.ellipse(o.x + 3, o.y + 6, o.r + 8, (o.r + 8) * 0.5, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#6d4c33';
        g.beginPath(); g.arc(o.x, o.y, 7, 0, Math.PI * 2); g.fill();
      } else if (o.kind === 'pillar') {
        g.fillStyle = 'rgba(0,0,0,0.2)';
        g.beginPath(); g.ellipse(o.x + 2, o.y + 3, o.r + 2, (o.r + 2) * 0.5, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#8c8577';
        g.beginPath(); g.arc(o.x, o.y, o.r, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#b3aa98';
        g.beginPath(); g.arc(o.x - 2, o.y - 2, o.r * 0.5, 0, Math.PI * 2); g.fill();
      }
    }

    // Çeşme havuzu tabanı (sabit kısım zemin canvas'ına bir kez çizilir)
    if (map.fountain) {
      const { x, y, r } = map.fountain;
      g.fillStyle = 'rgba(0,0,0,0.2)';
      g.beginPath(); g.ellipse(x + 4, y + 7, r + 4, (r + 4) * 0.62, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#9a9388';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#c4bcae';
      g.beginPath(); g.arc(x, y, r - 6, 0, Math.PI * 2); g.fill();
      const water = g.createRadialGradient(x, y, 4, x, y, r - 9);
      water.addColorStop(0, '#85d8ff');
      water.addColorStop(1, '#3b92c4');
      g.fillStyle = water;
      g.beginPath(); g.arc(x, y, r - 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#9a9388';
      g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#d8d2c7';
      g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
    }

    // 6 küçük heykelin taş kaideleri (sabit kısım zemin canvas'ına bir kez çizilir)
    for (const s of map.statues || []) {
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.beginPath(); g.ellipse(s.x + 2, s.y + 4, s.r + 3, (s.r + 3) * 0.58, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#9a9388';
      g.beginPath(); g.arc(s.x, s.y, s.r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#c4bcae';
      g.beginPath(); g.arc(s.x, s.y, s.r - 4, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#7d766b';
      g.fillRect(s.x - 6, s.y - 16, 12, 16);
      g.fillStyle = '#a39b8e';
      g.fillRect(s.x - 8, s.y - 19, 16, 4);
    }

    g.strokeStyle = '#8a7a5c';
    g.lineWidth = 4;
    g.strokeRect(2, 2, map.width - 4, map.height - 4);

    // Ağaç tepesi (canopy) sprite'ı bir kez hazırlanır
    const cr = 30;
    const cSize = safeDim((cr * 2 + 4) * k);
    canopyCanvas = makeCanvas(cSize, cSize);
    const cc = canopyCanvas.getContext('2d');
    cc.scale(k, k);
    cc.translate(cr + 2, cr + 2);
    cc.globalAlpha = 0.92;
    cc.fillStyle = '#4f9d48';
    cc.beginPath(); cc.arc(0, 0, cr, 0, Math.PI * 2); cc.fill();
    cc.fillStyle = '#6cbf5f';
    cc.beginPath(); cc.arc(-cr * 0.3, -cr * 0.3, cr * 0.55, 0, Math.PI * 2); cc.fill();
    cc.fillStyle = '#3f7f3a';
    cc.beginPath(); cc.arc(cr * 0.35, cr * 0.3, cr * 0.45, 0, Math.PI * 2); cc.fill();

    // 4 çatı yüzeyi bir kez kendi offscreen canvas'larına çizilir:
    // opak (avcı) ve yarı saydam (saklanan) sürüm + piksel boyutu (bw, bh)
    for (const r of map.roofs) {
      const bw = safeDim(r.w * k);
      const bh = safeDim(r.h * k);
      const opaqueC = makeCanvas(bw, bh);
      const og = opaqueC.getContext('2d');
      og.scale(k, k);
      og.translate(-r.x, -r.y);
      drawRoofSurface(og, r, 1);
      const transC = makeCanvas(bw, bh);
      const tg = transC.getContext('2d');
      tg.scale(k, k);
      tg.translate(-r.x, -r.y);
      drawRoofSurface(tg, r, 0.45);
      roofCache.set(r.id, { opaque: opaqueC, translucent: transC, bw, bh });
    }

    // Yumuşak kenarlı nişangâh deliği (maske + kenar gölgesi) sprite'ları bir kez hazırlanır
    const peekR = (data && data.peekRadius) || 80;
    const pSize = safeDim(peekR * 2 * k);
    peekMaskCanvas = makeCanvas(pSize, pSize);
    const pm = peekMaskCanvas.getContext('2d');
    pm.scale(k, k);
    const mGrad = pm.createRadialGradient(peekR, peekR, peekR * 0.72, peekR, peekR, peekR);
    mGrad.addColorStop(0, 'rgba(0,0,0,1)');
    mGrad.addColorStop(1, 'rgba(0,0,0,0)');
    pm.fillStyle = mGrad;
    pm.beginPath();
    pm.arc(peekR, peekR, peekR, 0, Math.PI * 2);
    pm.fill();

    peekRimCanvas = makeCanvas(pSize, pSize);
    const pr = peekRimCanvas.getContext('2d');
    pr.scale(k, k);
    const rGrad = pr.createRadialGradient(peekR, peekR, peekR * 0.72, peekR, peekR, peekR);
    rGrad.addColorStop(0, 'rgba(0,0,0,0)');
    rGrad.addColorStop(0.85, 'rgba(20,12,8,0.28)');
    rGrad.addColorStop(1, 'rgba(20,12,8,0)');
    pr.fillStyle = rGrad;
    pr.beginPath();
    pr.arc(peekR, peekR, peekR, 0, Math.PI * 2);
    pr.fill();
  }

  // Aynı çizim hatası konsola saniyede en fazla bir kez yazılır
  let lastDrawErrMsg = '';
  let lastDrawErrAt = 0;
  function reportDrawError(err) {
    const msg = (err && err.message) || String(err);
    const tNow = now();
    if (msg !== lastDrawErrMsg || tNow - lastDrawErrAt >= 1000) {
      lastDrawErrMsg = msg;
      lastDrawErrAt = tNow;
      console.error('[çizim hatası]', err);
    }
  }

  // Her karenin başında canvas durumunu sıfırla (transform, saydamlık, birleştirme modu)
  function resetCtxState() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame() {
    if (!running) return;
    // Döngü bir hatada durmasın: bir sonraki kare en başta istenir
    raf = requestAnimationFrame(frame);
    const t0 = now();
    try {
      resetCtxState();
      draw(t0);
    } catch (err) {
      reportDrawError(err);
      // Yarıda kalan save() yığınını temizle ki sonraki karelere taşmasın
      if (typeof ctx.reset === 'function') ctx.reset();
      else { const w = canvas.width; canvas.width = w; }
    }
    const drawCost = now() - t0;
    perfDrawMs = perfDrawMs ? perfDrawMs * 0.85 + drawCost * 0.15 : drawCost;
    perfFrameCount++;
    if (t0 - perfFpsWindowStart >= 500) {
      perfFps = Math.min(144, Math.round((perfFrameCount * 1000) / Math.max(1, t0 - perfFpsWindowStart)));
      perfFrameCount = 0;
      perfFpsWindowStart = t0;
    }
    try {
      updatePrompt();
      renderSkillHud();
      if (role === 'seeker') renderGun();
      renderPerfHud(false);
    } catch (err) {
      reportDrawError(err);
    }
  }

  // Ara doldurma: render zamanı için konum/açı örnekle (100 ms geriden yumuşak geçiş)
  function sample(c, rt) {
    const b = c.buf;
    if (b.length === 0) return null;
    if (rt <= b[0].t) return b[0];
    for (let i = b.length - 1; i >= 0; i--) {
      if (b[i].t <= rt) {
        if (i === b.length - 1) return b[i];
        const p = b[i], q = b[i + 1];
        const f = (rt - p.t) / Math.max(1, q.t - p.t);
        return { x: lerp(p.x, q.x, f), y: lerp(p.y, q.y, f), a: lerpAngle(p.a, q.a, f) };
      }
    }
    return b[0];
  }

  function isPointUnderAnyRoof(x, y) {
    if (!map || !map.roofs) return false;
    for (const rf of map.roofs) {
      if (x >= rf.x && x <= rf.x + rf.w && y >= rf.y && y <= rf.y + rf.h) return true;
    }
    return false;
  }

  function draw(t = now()) {
    const frameDt = Math.min(50, Math.max(1, t - (lastFrameAt || t)));
    lastFrameAt = t;
    const fadeMs = (data && data.charFadeMs) || DEFAULT_FADE_MS;
    const rt = t - INTERP_DELAY;
    const W = canvas.width, H = canvas.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1f1a17';
    ctx.fillRect(0, 0, W, H);

    const k = view.scale * view.dpr;
    ctx.setTransform(k, 0, 0, k, view.ox * view.dpr, view.oy * view.dpr);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, map.width, map.height);
    ctx.clip();

    // Sabit arka planı tek seferde kopyala
    ctx.setTransform(1, 0, 0, 1, view.ox * view.dpr, view.oy * view.dpr);
    if (canDraw(groundCanvas)) ctx.drawImage(groundCanvas, 0, 0);
    ctx.setTransform(k, 0, 0, k, view.ox * view.dpr, view.oy * view.dpr);

    // Çeşme su halkası ve 6 heykelin değişebilen üst figürleri
    if (map.fountain) drawFountainRipples(map.fountain, t);
    for (const st of map.statues || []) drawStatueFigure(st);

    const peekR = (data && data.peekRadius) || 80;
    const peekOn = role === 'seeker' && phase === 'play' && mouse.inside && isPointUnderAnyRoof(mouse.x, mouse.y);

    // Karakterleri Y koordinatına göre sırala; görünür alana girip çıkanları 150 ms'de yumuşakça belir/kaybol
    const vipId = tasks && tasks.vipId;
    const items = [];
    const roofVipOverlay = [];
    for (const [id, c] of chars) {
      if (c.visible) {
        c.alpha = Math.min(1, (c.alpha ?? 1) + frameDt / fadeMs);
      } else {
        c.alpha = Math.max(0, (c.alpha ?? 0) - frameDt / fadeMs);
      }
      if (c.alpha <= 0.01) continue;

      const s = sample(c, rt);
      if (!s) continue;
      const look = looks.get(id);
      if (!look) continue;
      const dead = (c.flags & 2) !== 0;
      const moving = (c.flags & 1) !== 0;
      const seekerVipHp = role === 'seeker' && !dead ? seekerVips.get(id) : undefined;
      const alpha = c.alpha;

      // Avcıda çatı altındaki normal karakterler (140 br ön yükleme ile gelenler) farenin GERÇEK konumundaki
      // 80 birimlik deliğe göre kırpılır (clip); 80 br dışındakiler çizilmez.
      const underRoofChar = role === 'seeker' && seekerVipHp === undefined && isPointUnderAnyRoof(s.x, s.y);
      if (underRoofChar) {
        if (!peekOn || Math.hypot(s.x - mouse.x, s.y - mouse.y) > peekR + 18) continue;
      }

      const renderFn = () => {
        if (underRoofChar) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(mouse.x, mouse.y, peekR, 0, Math.PI * 2);
          ctx.clip();
          drawChar(
            s.x, s.y, s.a, moving, dead, look, c.prog,
            id === myCharId && !eliminated, id === vipId && !dead, seekerVipHp, id, t, alpha,
          );
          ctx.restore();
        } else {
          drawChar(
            s.x, s.y, s.a, moving, dead, look, c.prog,
            id === myCharId && !eliminated, id === vipId && !dead, seekerVipHp, id, t, alpha,
          );
        }
      };

      items.push({
        y: s.y + (dead ? -6 : 0),
        fn: renderFn,
      });
      if (seekerVipHp !== undefined) {
        roofVipOverlay.push({ y: s.y, fn: renderFn });
      }
    }
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.fn();

    for (const o of map.obstacles) if (o.kind === 'tree') drawCanopy(o, k);

    for (const r of map.roofs) drawRoof(r, peekOn, peekR, k);

    // Elmaslar çatının üstüne çizilir; avcı kapalı alandaki elmasları da her zaman görür
    for (const d of diamonds) drawDiamond(d, t);

    // Aktif VIP'ler kapalı alanlarda da avcıya görünür
    if (roofVipOverlay.length) {
      roofVipOverlay.sort((a, b) => a.y - b.y);
      for (const it of roofVipOverlay) it.fn();
    }

    // Heykel görevi açıkken saklananın ekranında heykellerin üstünde küçük 🗿 işareti
    if (role === 'hider' && !eliminated && tasks && tasks.stage === 'statue') {
      drawStatueMarkers(t);
    }

    // Kalabalığı Azalt puf efektleri
    puffs = puffs.filter((p) => t - p.t0 < p.dur);
    for (const p of puffs) drawPuff(p, t);

    // Elmas alma parlaması
    sparkles = sparkles.filter((s) => t - s.t0 < SPARKLE_MS);
    for (const s of sparkles) drawSparkle(s, t);

    // Sis bulutları (avcıya opak, saklananlara yarı saydam)
    for (const sm of smokes) drawSmoke(sm, t);

    // Radar bombaları (0,8 sn düşüş + gölge, 3 sn 130 br alan + avcıya oyuncu sayısı)
    for (const rb of radars) drawRadar(rb, t);

    // Saklananların ok işaretleri: çatıların ve sisin üstüne çizilir; avcı ekranında ASLA çizilmez
    if (role === 'hider') {
      drawHiderArrows(t, rt);
    }

    shots = shots.filter((s) => t - s.t0 < 320);
    for (const s of shots) drawShot(s, t);

    ctx.restore();

    if (t < flashUntil) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(0, 0, W, H);
      ctx.setTransform(k, 0, 0, k, view.ox * view.dpr, view.oy * view.dpr);
    }

    if (role === 'seeker' && mouse.inside && radarAiming) drawRadarAim();
  }

  // ---------- elmas ----------
  function drawDiamond(d, t) {
    const x = d.x, y = d.y;
    const bob = Math.sin(t / 400 + d.id) * 1.5;
    ctx.save();
    ctx.translate(x, y);
    // gölge
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(0, 6, 7, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.translate(0, bob);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#5ee7ff';
    ctx.strokeStyle = '#1b8fb0';
    ctx.lineWidth = 1.5;
    ctx.fillRect(-6, -6, 12, 12);
    ctx.strokeRect(-6, -6, 12, 12);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(-5, -5, 5, 5);
    ctx.restore();
  }

  // ---------- dekor, çeşme ve 6 küçük heykel ----------
  function drawCanopy(o, k) {
    if (canDraw(canopyCanvas)) {
      const r = o.r + 10;
      const half = r + 14;
      ctx.drawImage(canopyCanvas, 0, 0, canopyCanvas.width, canopyCanvas.height, o.x - half, o.y - 6 - half, half * 2, half * 2);
      return;
    }
    const r = o.r + 10;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = '#4f9d48';
    ctx.beginPath(); ctx.arc(o.x, o.y - 6, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6cbf5f';
    ctx.beginPath(); ctx.arc(o.x - r * 0.3, o.y - 6 - r * 0.3, r * 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3f7f3a';
    ctx.beginPath(); ctx.arc(o.x + r * 0.35, o.y - 6 + r * 0.3, r * 0.45, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawFountainRipples(f, t) {
    const { x, y, r } = f;
    // Su dalgası halkaları (havuz tabanı groundCanvas'ta önbellekli)
    for (let i = 0; i < 2; i++) {
      const p = ((t / 1300) + i * 0.5) % 1;
      ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - p) * 0.55})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(x, y, 8 + p * (r - 19), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(220, 248, 255, 0.85)';
    ctx.beginPath(); ctx.arc(x, y - 1, 2.5 + Math.sin(t / 160) * 0.6, 0, Math.PI * 2); ctx.fill();
  }

  function drawStatueFigure(s) {
    // Kaide ve sütun groundCanvas'ta önbellekli; burada yalnız üstteki renkli şekil çizilir
    const fig = statues.get(s.id) || { shape: 'star', color: '#d4a62a' };
    const cx = s.x, cy = s.y - 29, R = 9;
    ctx.fillStyle = fig.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    switch (fig.shape) {
      case 'circle': ctx.arc(cx, cy, R, 0, Math.PI * 2); break;
      case 'square': ctx.rect(cx - R, cy - R, R * 2, R * 2); break;
      case 'triangle': ctx.moveTo(cx, cy - R); ctx.lineTo(cx + R, cy + R); ctx.lineTo(cx - R, cy + R); ctx.closePath(); break;
      case 'diamond': ctx.moveTo(cx, cy - R); ctx.lineTo(cx + R, cy); ctx.lineTo(cx, cy + R); ctx.lineTo(cx - R, cy); ctx.closePath(); break;
      default: // star
        for (let i = 0; i < 10; i++) {
          const rr = i % 2 === 0 ? R : R * 0.45;
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();
  }

  function drawStatueMarkers(t) {
    ctx.save();
    ctx.font = '15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const s of map.statues || []) {
      const y = s.y - 40 + Math.sin(t / 280 + s.id) * 2.5;
      ctx.fillStyle = 'rgba(20, 12, 8, 0.55)';
      ctx.beginPath(); ctx.arc(s.x, y - 8, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillText('🗿', s.x, y);
    }
    ctx.restore();
  }

  function drawRoofSurface(g, r, alpha) {
    g.save();
    g.globalAlpha = alpha;
    g.fillStyle = r.color;
    g.fillRect(r.x, r.y, r.w, r.h);
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.strokeStyle = r.accent;
    g.fillStyle = r.accent;
    if (r.style === 'stripes') {
      for (let x = r.x - r.h; x < r.x + r.w + r.h; x += 28) {
        g.beginPath(); g.moveTo(x, r.y); g.lineTo(x + r.h, r.y + r.h); g.lineTo(x + r.h + 14, r.y + r.h); g.lineTo(x + 14, r.y); g.closePath(); g.fill();
      }
    } else if (r.style === 'tiles') {
      g.lineWidth = 2;
      for (let y = r.y; y < r.y + r.h; y += 16) {
        g.beginPath(); g.moveTo(r.x, y); g.lineTo(r.x + r.w, y); g.stroke();
        const off = ((y - r.y) / 16) % 2 ? 12 : 0;
        for (let x = r.x + off; x < r.x + r.w; x += 24) {
          g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 16); g.stroke();
        }
      }
    } else if (r.style === 'planks') {
      g.lineWidth = 3;
      for (let x = r.x; x < r.x + r.w; x += 22) {
        g.beginPath(); g.moveTo(x, r.y); g.lineTo(x, r.y + r.h); g.stroke();
      }
    } else { // glass
      g.lineWidth = 3;
      for (let x = r.x; x <= r.x + r.w; x += 40) { g.beginPath(); g.moveTo(x, r.y); g.lineTo(x, r.y + r.h); g.stroke(); }
      g.lineWidth = 3;
      for (let y = r.y; y <= r.y + r.h; y += 40) { g.beginPath(); g.moveTo(r.x, y); g.lineTo(r.x + r.w, y); g.stroke(); }
      g.globalAlpha *= 0.25;
      g.fillStyle = '#ffffff';
      g.beginPath(); g.moveTo(r.x, r.y + r.h); g.lineTo(r.x + r.w * 0.45, r.y); g.lineTo(r.x + r.w * 0.65, r.y); g.lineTo(r.x + r.w * 0.2, r.y + r.h); g.closePath(); g.fill();
    }
    g.restore();
    g.save();
    g.globalAlpha = Math.max(0.7, alpha);
    g.font = '600 20px Fredoka, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillText(r.name, r.x + r.w / 2 + 1, r.y + r.h / 2 + 1);
    g.fillStyle = '#fff';
    g.fillText(r.name, r.x + r.w / 2, r.y + r.h / 2);
    g.restore();
  }

  function circleIntersectsRect(cx, cy, cr, r) {
    const nx = Math.max(r.x, Math.min(cx, r.x + r.w));
    const ny = Math.max(r.y, Math.min(cy, r.y + r.h));
    const dx = cx - nx, dy = cy - ny;
    return dx * dx + dy * dy <= cr * cr;
  }

  function drawRoof(r, peekOn, peekR, k) {
    const opaque = role === 'seeker';
    const cached = roofCache.get(r.id);
    if (!opaque) {
      if (cached && canDraw(cached.translucent)) {
        ctx.drawImage(cached.translucent, 0, 0, cached.translucent.width, cached.translucent.height, r.x, r.y, r.w, r.h);
      } else {
        drawRoofSurface(ctx, r, 0.45);
      }
    } else if (!peekOn || !circleIntersectsRect(mouse.x, mouse.y, peekR, r)) {
      drawOpaqueRoof(r, cached);
    } else {
      // Delik tamponu her zaman çatının TAMAMI kadar (kesişim kadar değil), en az 1 piksel
      const bw = cached ? safeDim(cached.bw) : safeDim(r.w * k);
      const bh = cached ? safeDim(cached.bh) : safeDim(r.h * k);
      if (!roofBuf) roofBuf = makeCanvas(bw, bh);
      if (roofBuf.width !== bw || roofBuf.height !== bh) {
        roofBuf.width = bw;
        roofBuf.height = bh;
      }
      if (!canDraw(roofBuf) || !Number.isFinite(mouse.x) || !Number.isFinite(mouse.y)) {
        // Güvenli geri dönüş: çatıyı normal (opak, deliksiz) çiz
        drawOpaqueRoof(r, cached);
      } else {
        const rc = roofBuf.getContext('2d');
        rc.setTransform(1, 0, 0, 1, 0, 0);
        rc.globalAlpha = 1;
        rc.globalCompositeOperation = 'source-over';
        rc.clearRect(0, 0, bw, bh);
        if (cached && canDraw(cached.opaque)) {
          rc.drawImage(cached.opaque, 0, 0, cached.opaque.width, cached.opaque.height, 0, 0, bw, bh);
        } else {
          rc.save();
          rc.scale(k, k);
          rc.translate(-r.x, -r.y);
          drawRoofSurface(rc, r, 1);
          rc.restore();
        }
        rc.save();
        rc.scale(k, k);
        rc.translate(-r.x, -r.y);
        rc.globalCompositeOperation = 'destination-out';
        if (canDraw(peekMaskCanvas)) {
          rc.drawImage(peekMaskCanvas, 0, 0, peekMaskCanvas.width, peekMaskCanvas.height, mouse.x - peekR, mouse.y - peekR, peekR * 2, peekR * 2);
        } else {
          rc.fillStyle = 'rgba(0,0,0,1)';
          rc.beginPath();
          rc.arc(mouse.x, mouse.y, peekR, 0, Math.PI * 2);
          rc.fill();
        }
        rc.restore();

        ctx.drawImage(roofBuf, 0, 0, bw, bh, r.x, r.y, r.w, r.h);

        // Yumuşak delik kenarı gölgesi (hazır sprite ile, her karede gradyan oluşturmadan)
        if (canDraw(peekRimCanvas)) {
          ctx.save();
          ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
          ctx.drawImage(peekRimCanvas, 0, 0, peekRimCanvas.width, peekRimCanvas.height, mouse.x - peekR, mouse.y - peekR, peekR * 2, peekR * 2);
          ctx.restore();
        }
      }
    }

    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }

  function drawOpaqueRoof(r, cached) {
    if (cached && canDraw(cached.opaque)) {
      ctx.drawImage(cached.opaque, 0, 0, cached.opaque.width, cached.opaque.height, r.x, r.y, r.w, r.h);
    } else {
      drawRoofSurface(ctx, r, 1);
    }
  }

  // ---------- karakter önbelleği (kıyafet + şapka + ten + ölü/canlı) ----------
  function getCharSprite(outfitIdx, hatIdx, skinIdx, dead, k) {
    const oIdx = ((outfitIdx | 0) % OUTFITS.length + OUTFITS.length) % OUTFITS.length;
    const sIdx = ((skinIdx | 0) % SKINS.length + SKINS.length) % SKINS.length;
    const hIdx = hatIdx >= 0 ? (hatIdx | 0) % HAT_COLORS.length : -1;
    const key = `${oIdx}:${hIdx}:${sIdx}:${dead ? 1 : 0}:${Math.round(k * 100)}`;
    let sp = charSpriteCache.get(key);
    if (sp) return sp;

    const R = (data && data.charRadius) || 12;
    const half = dead ? R + 10 : R + 16;
    const size = half * 2;
    const pw = safeDim(size * k);
    const c = makeCanvas(pw, pw);
    const g = c.getContext('2d');
    g.scale(k, k);
    g.translate(half, half);

    if (dead) {
      g.globalAlpha = 0.9;
      g.fillStyle = 'rgba(120,20,20,0.35)';
      g.beginPath(); g.ellipse(0, 4, R + 8, R, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = OUTFITS[oIdx];
      g.beginPath(); g.ellipse(0, 2, R * 0.8, R + 1, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = SKINS[sIdx];
      g.beginPath(); g.arc(0, -R + 1, R * 0.6, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#333'; g.lineWidth = 1.5;
      for (const sx of [-3, 3]) {
        g.beginPath(); g.moveTo(sx - 2, -R - 1); g.lineTo(sx + 2, -R + 3); g.moveTo(sx + 2, -R - 1); g.lineTo(sx - 2, -R + 3); g.stroke();
      }
    } else {
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.beginPath(); g.ellipse(1, R - 2, R * 0.9, R * 0.45, 0, 0, Math.PI * 2); g.fill();

      g.fillStyle = OUTFITS[oIdx];
      g.strokeStyle = 'rgba(0,0,0,0.25)';
      g.lineWidth = 1.5;
      g.beginPath(); g.ellipse(0, 0, R * 0.75, R * 0.95, 0, 0, Math.PI * 2); g.fill(); g.stroke();

      const hy = -R * 0.8;
      const hr = R * 0.62;
      g.fillStyle = SKINS[sIdx];
      g.beginPath(); g.arc(0, hy, hr, 0, Math.PI * 2); g.fill(); g.stroke();

      if (hIdx >= 0) drawHatOn(g, hIdx, hy, hr);
    }

    sp = { canvas: c, pw, half, size };
    charSpriteCache.set(key, sp);
    return sp;
  }

  // ---------- karakter ----------
  function drawChar(x, y, a, moving, dead, look, prog, isMe, isVip, seekerVipHp, id, t, alpha = 1) {
    const R = data.charRadius || 12;
    const k = view.scale * view.dpr;
    const sp = getCharSprite(look.outfit, look.hat, look.skin, dead, k);
    ctx.save();
    ctx.translate(x, y);
    if (alpha < 0.999) ctx.globalAlpha = alpha;

    if (dead) {
      ctx.rotate(a + Math.PI / 2);
      ctx.drawImage(sp.canvas, 0, 0, sp.pw, sp.pw, -sp.half, -sp.half, sp.size, sp.size);
      ctx.restore();
      return;
    }

    // VIP vuruşu animasyonları: vurulan VIP sarsılır, vuran karakter öne atılıp yumruk sallar
    const animMs = (data && data.punchAnimMs) || 260;
    const sh = shakes.get(id);
    if (sh !== undefined) {
      const f = (t - sh) / animMs;
      if (f >= 1 || f < 0) shakes.delete(id);
      else ctx.translate(Math.sin(f * Math.PI * 6) * 3.4 * (1 - f), Math.sin(f * Math.PI * 4) * 1.2 * (1 - f));
    }
    let punchF = -1, punchAng = a;
    const pu = punches.get(id);
    if (pu) {
      const f = (t - pu.t0) / animMs;
      if (f >= 1 || f < 0) punches.delete(id);
      else {
        punchF = f;
        if (pu.ang !== null) punchAng = pu.ang;
        const lunge = Math.sin(f * Math.PI) * 5;
        ctx.translate(Math.cos(punchAng) * lunge, Math.sin(punchAng) * lunge);
      }
    }

    const bob = moving ? Math.sin(t / 80 + id) * 1.6 : 0;
    const tilt = moving ? Math.sin(t / 160 + id) * 0.08 : 0;

    // VIP işareti: kırmızı kesikli halka (sadece hedefin sahibi görür)
    if (isVip) {
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineDashOffset = -t / 40;
      ctx.strokeStyle = 'rgba(255, 50, 50, 0.95)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(0, 0, R + 9, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    if (tilt !== 0) ctx.rotate(tilt);
    ctx.drawImage(sp.canvas, 0, 0, sp.pw, sp.pw, -sp.half, -sp.half + bob, sp.size, sp.size);

    const hy = -R * 0.8 + bob;
    const hr = R * 0.62;
    const ex = Math.cos(a) * hr * 0.45;
    const ey = Math.sin(a) * hr * 0.35;
    const px = -Math.sin(a) * 2.6, py = Math.cos(a) * 2.6;
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(ex + px, hy + ey + py, 1.5, 0, Math.PI * 2);
    ctx.arc(ex - px, hy + ey - py, 1.5, 0, Math.PI * 2);
    ctx.fill();
    if (tilt !== 0) ctx.rotate(-tilt);

    // Yumruk: ten renginde küçük el öne uzanır, vuruş anında darbe çizgileri
    if (punchF >= 0) {
      const reach = R * 0.7 + Math.sin(punchF * Math.PI) * 11;
      const fx = Math.cos(punchAng) * reach, fy = Math.sin(punchAng) * reach;
      ctx.fillStyle = SKINS[look.skin % SKINS.length];
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(fx, fy, 4.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (punchF > 0.3 && punchF < 0.8) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.6;
        for (const da of [-0.6, 0, 0.6]) {
          const ang = punchAng + da;
          ctx.beginPath();
          ctx.moveTo(fx + Math.cos(ang) * 6, fy + Math.sin(ang) * 6);
          ctx.lineTo(fx + Math.cos(ang) * 11, fy + Math.sin(ang) * 11);
          ctx.stroke();
        }
      }
    }

    if (prog >= 0) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.arc(0, 0, R + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(0, 0, R + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog); ctx.stroke();
    }

    if (isVip) {
      const fl = Math.sin(t / 300) * 2;
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('🎯', 0, hy - hr - 6 + fl);
      const need = (tasks && tasks.vipHitsNeeded) || 3;
      const hits = (tasks && tasks.vipHits) || 0;
      drawVipNotches(0, hy - hr - 26 + fl, need, Math.max(0, need - hits));
    } else if (seekerVipHp !== undefined) {
      // Avcının gördüğü aktif VIP: 👑 işareti ve 3 çentikli can göstergesi (sahibi gizli)
      const fl = Math.sin(t / 300 + id) * 2;
      ctx.font = '15px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('👑', 0, hy - hr - 6 + fl);
      const need = (data && data.vipHitsNeeded) || 3;
      drawVipNotches(0, hy - hr - 26 + fl, need, seekerVipHp);
    }

    ctx.restore();
  }

  // Saklananların başının üstündeki renkli ok işaretleri (çatıların ve sisin üstünde; isim yazmaz)
  function drawHiderArrows(t, rt) {
    if (role !== 'hider' || !hiderArrows.size) return;
    const R = (data && data.charRadius) || 12;
    const ac = (data && data.arrowCfg) || {};
    const baseW = ac.width || 14;
    const baseH = ac.height || 12;
    const headGap = ac.headGap || 10;
    const bobAmp = ac.bobAmp || 2.5;
    const hy = -R * 0.8;
    const hr = R * 0.62;
    const bob = Math.sin(t / 460) * bobAmp;

    // Önce diğer saklananların okları, en üste kendi okumuz çizilsin
    const entries = [...hiderArrows.entries()].sort((a, b) => (a[0] === myCharId ? 1 : b[0] === myCharId ? -1 : 0));
    for (const [charId, colorHex] of entries) {
      const c = chars.get(charId);
      if (!c || (c.alpha !== undefined && c.alpha <= 0.01)) continue;
      if ((c.flags & 2) !== 0) continue; // Vurulan (elenen) saklananın oku kaybolur
      const s = sample(c, rt);
      if (!s) continue;

      const isMine = charId === myCharId;
      const w = isMine ? baseW + 2.5 : baseW;
      const h = isMine ? baseH + 2 : baseH;
      const tipY = s.y + hy - hr - headGap + bob;

      ctx.save();
      ctx.translate(s.x, tipY);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-w / 2, -h);
      ctx.lineTo(0, -h * 0.78);
      ctx.lineTo(w / 2, -h);
      ctx.closePath();
      ctx.fillStyle = colorHex || '#e74c3c';
      ctx.fill();
      ctx.lineJoin = 'round';
      ctx.lineWidth = isMine ? 2.8 : 1.7;
      ctx.strokeStyle = isMine ? '#140c08' : 'rgba(20, 12, 8, 0.88)';
      ctx.stroke();
      ctx.restore();
    }
  }

  // 3 çentikli VIP can göstergesi (her vuruşta 1 çentik eksilir)
  function drawVipNotches(cx, cy, total, hpLeft) {
    const w = 8, h = 5, gap = 3;
    const fullW = total * w + (total - 1) * gap;
    const x0 = cx - fullW / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(20, 12, 8, 0.72)';
    ctx.fillRect(x0 - 2, cy - h / 2 - 2, fullW + 4, h + 4);
    for (let i = 0; i < total; i++) {
      const nx = x0 + i * (w + gap);
      const filled = i < hpLeft;
      ctx.fillStyle = filled ? (hpLeft === 1 ? '#ff4757' : hpLeft === 2 ? '#ffa502' : '#2ed573') : 'rgba(90, 75, 70, 0.55)';
      ctx.fillRect(nx, cy - h / 2, w, h);
      ctx.strokeStyle = filled ? '#ffffff' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(nx, cy - h / 2, w, h);
    }
    ctx.restore();
  }

  function drawHatOn(g, type, hy, hr) {
    g.fillStyle = HAT_COLORS[type % HAT_COLORS.length];
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 1;
    const top = hy - hr;
    g.beginPath();
    switch (type) {
      case 0: // kasket
        g.arc(0, top + 3, hr * 0.95, Math.PI, 0); g.closePath(); g.fill();
        g.fillRect(-hr * 1.1, top + 1, hr * 1.6, 2.5);
        break;
      case 1: // silindir
        g.fillRect(-hr * 0.7, top - 9, hr * 1.4, 10);
        g.fillRect(-hr * 1.05, top - 1, hr * 2.1, 3);
        break;
      case 2: // bere (ponponlu)
        g.arc(0, top + 3, hr * 0.95, Math.PI, 0); g.closePath(); g.fill();
        g.beginPath(); g.arc(0, top - 6, 3, 0, Math.PI * 2); g.fill();
        break;
      case 3: // kovboy
        g.ellipse(0, top + 2, hr * 1.5, 3.5, 0, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.ellipse(0, top - 3, hr * 0.7, 6, 0, 0, Math.PI * 2); g.fill();
        break;
      case 4: // bere (fransız)
        g.ellipse(2, top + 1, hr * 1.1, 4.5, -0.3, 0, Math.PI * 2); g.fill();
        break;
      default: // parti külahı
        g.moveTo(0, top - 12); g.lineTo(-5, top + 2); g.lineTo(5, top + 2); g.closePath(); g.fill();
        g.fillStyle = '#fff'; g.beginPath(); g.arc(0, top - 12, 2, 0, Math.PI * 2); g.fill();
    }
    g.stroke();
  }

  // ---------- puf ve sis efektleri ----------
  function drawPuff(p, t) {
    const f = Math.max(0, Math.min(1, (t - p.t0) / p.dur));
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = 1 - f;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + f * 0.4;
      const dist = 4 + f * 18;
      const r = Math.max(2, 9 * (1 - f * 0.45));
      ctx.fillStyle = i % 2 ? '#f5efe6' : '#ffffff';
      ctx.beginPath(); ctx.arc(Math.cos(a) * dist, Math.sin(a) * dist, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // Elmas alınınca: büyüyüp sönen halka + dışa saçılan 4 köşeli yıldızcıklar
  function drawSparkle(s, t) {
    const f = Math.max(0, Math.min(1, (t - s.t0) / SPARKLE_MS));
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.arc(0, 0, 6 * (1 - f) + 1, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#5ee7ff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 4 + f * 16, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const d = 5 + f * 18;
      const r = 3.2 * (1 - f * 0.6);
      const px = Math.cos(a) * d, py = Math.sin(a) * d;
      ctx.fillStyle = i % 2 ? '#ffffff' : '#bff6ff';
      ctx.beginPath();
      ctx.moveTo(px, py - r); ctx.lineTo(px + r * 0.35, py - r * 0.35);
      ctx.lineTo(px + r, py); ctx.lineTo(px + r * 0.35, py + r * 0.35);
      ctx.lineTo(px, py + r); ctx.lineTo(px - r * 0.35, py + r * 0.35);
      ctx.lineTo(px - r, py); ctx.lineTo(px - r * 0.35, py - r * 0.35);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  function drawSmoke(sm, t) {
    const r = (data.skillsCfg && data.skillsCfg.smokeRadius) || 90;
    const opaque = role === 'seeker';
    const sec = Math.max(0, Math.ceil(sm.leftMs / 1000));

    ctx.save();
    ctx.translate(sm.x, sm.y);
    ctx.globalAlpha = opaque ? 1 : 0.42;

    // Kenarı tamamen kaplayan opak sis tabanı
    ctx.fillStyle = '#cfd6dc';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();

    // Kabarık bulut halkaları
    const puffs = 9;
    for (let i = 0; i < puffs; i++) {
      const a = (i / puffs) * Math.PI * 2 + t / 5000;
      const px = Math.cos(a) * (r * 0.52);
      const py = Math.sin(a) * (r * 0.52);
      ctx.fillStyle = i % 2 ? '#e3e8ec' : '#bfc8d0';
      ctx.beginPath(); ctx.arc(px, py, r * 0.48, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#eef2f5';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.58, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = 'rgba(130, 145, 158, 0.85)';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();

    ctx.globalAlpha = opaque ? 0.9 : 0.75;
    ctx.font = '700 14px Fredoka, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#36414a';
    ctx.fillText(`🌫️ ${sec}s`, 0, 0);
    ctx.restore();
  }

  // ---------- radar bombası ----------
  function drawRadar(rb, t) {
    const r = (data && data.skillsCfg && data.skillsCfg.radarRadius) || 130;
    ctx.save();
    ctx.translate(rb.x, rb.y);

    if (!rb.landed) {
      // 0,8 sn düşüş: yerde büyüyen gölge + yukarıdan inen radar bombası
      const p = 1 - Math.max(0, Math.min(1, rb.leftMs / Math.max(1, rb.totalMs)));
      const shadowRx = 6 + p * 14;
      const shadowRy = 3 + p * 7;
      ctx.fillStyle = `rgba(0, 0, 0, ${0.15 + p * 0.35})`;
      ctx.beginPath();
      ctx.ellipse(0, 4, shadowRx, shadowRy, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(94, 231, 255, ${0.25 + p * 0.45})`;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.arc(0, 0, r * (0.2 + 0.8 * p), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      const dropY = -(1 - p * p) * 115;
      ctx.fillStyle = '#2d3436';
      ctx.strokeStyle = '#5ee7ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, dropY, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = '15px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('📡', 0, dropY);
      ctx.restore();
      return;
    }

    // Yere düştü: 3 sn boyunca 130 br alan görünür; sayıyı sadece avcı görür
    const pulse = ((t / 900) % 1);
    ctx.fillStyle = 'rgba(46, 213, 115, 0.13)';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = `rgba(94, 231, 255, ${(1 - pulse) * 0.65})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, pulse * r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(46, 213, 115, 0.88)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Yerdeki bomba gövdesi ve gölgesi
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(0, 5, 13, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#1e272e';
    ctx.strokeStyle = '#2ed573';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📡', 0, 0);

    // Gerçek oyuncu sayısı (sadece avcıya gönderilir ve sadece avcı görür)
    if (role === 'seeker' && typeof rb.count === 'number') {
      const label = String(rb.count);
      ctx.font = '700 36px Fredoka, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(20, 12, 8, 0.88)';
      ctx.strokeText(label, 0, -14);
      ctx.fillStyle = rb.count > 0 ? '#ffd166' : '#dfe6e9';
      ctx.fillText(label, 0, -14);
    }

    ctx.restore();
  }

  // ---------- efektler ----------
  function drawShot(s, t) {
    const f = (t - s.t0) / 320;
    const r = 4 + f * 26;
    ctx.globalAlpha = 1 - f;
    ctx.fillStyle = '#fff3a0';
    ctx.beginPath(); ctx.arc(s.x, s.y, r * 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ff9f1c';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Nişangâh artık gerçek işletim sistemi imlecidir (cursor: url(nisangah.png) / nisangah-kilitli.png).
  // Canvas üzerinde yalnız Radar Bombası nişan modundayken 130 birimlik hedef dairesi sıfır gecikmeyle çizilir.
  function drawRadarAim() {
    if (!radarAiming) return;
    const x = mouse.x, y = mouse.y;
    const r = (data && data.skillsCfg && data.skillsCfg.radarRadius) || 130;
    ctx.save();
    ctx.fillStyle = 'rgba(94, 231, 255, 0.14)';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(46, 213, 115, 0.92)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '700 13px Fredoka, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('📡 Radar (Tıkla)', x, y - 18);
    ctx.restore();
  }

  function getPerfStats() {
    return {
      fps: perfFps,
      pps: perfPps,
      pingMs: perfPingMs,
      lastPacketKb: perfLastPacketKb,
      drawMs: perfDrawMs,
    };
  }

  return { init, start, stop, showRoundEnd, showFinal, getPerfStats };
})();
