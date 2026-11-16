// ============================================================
//  Act Like NPC - Oyun mantığı (sunucu tarafı, bir TUR)
//  Bütün simülasyon burada çalışır; istemci sadece tuş girdisi
//  gönderir ve sunucudan gelen durumu çizer.
//  Tur sıralaması ve ekranlar server.js'de yönetilir.
// ============================================================

const { MAPS, DEFAULT_MAP } = require('./maps');

// ---------- Küçük yardımcılar ----------
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1)); // [a, b]
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r2 = (v) => Math.round(v * 100) / 100;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Açıyı -PI..PI aralığına getirir
function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function pointInRect(x, y, r, pad = 0) {
  return x >= r.x + pad && x <= r.x + r.w - pad && y >= r.y + pad && y <= r.y + r.h - pad;
}

const REASON_TEXT = {
  time: 'Süre doldu!',
  caught: 'Avcı bütün saklananları yakaladı!',
  tasks: 'Hayatta kalan saklananlar bütün görevleri bitirdi!',
  seekerLeft: 'Avcı oyundan ayrıldı',
};

// Ağ paketindeki konum yuvarlaması (tam sayı). Görünürlük/çatı kontrolleri de aynı
// yuvarlanmış konumla yapılır ki istemciye giden koordinatla aynı sonucu versin.
const rq = Math.round;
// Açı ağda tam sayı derece (0..359) olarak gider
const toDeg = (a) => { const d = Math.round((a * 180) / Math.PI) % 360; return d < 0 ? d + 360 : d; };

/**
 * Bu turdaki NPC sayısı: temel = min(NPC_MAX, NPC_BASE + NPC_PER_HIDER × saklanan),
 * sonra yoğunluk katıyla çarpılır ve yoğunluğun üst sınırıyla kırpılır.
 */
function npcCountFor(cfg, hiderCount, density) {
  const base = Math.min(cfg.NPC_MAX || Infinity, cfg.NPC_BASE + cfg.NPC_PER_HIDER * Math.max(0, hiderCount));
  const table = cfg.NPC_DENSITY || {};
  const d = table[density] || table[cfg.NPC_DENSITY_DEFAULT] || { mult: 1, max: Infinity };
  return Math.min(d.max, Math.round(base * d.mult));
}

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

function skillOptionsFor(role, cfg, cullUnlockLeft = cfg.CULL_UNLOCK_LEFT) {
  if (role === 'seeker') {
    return [
      {
        id: 'cull',
        key: 'Q',
        icon: '🧹',
        name: 'Kalabalığı Azalt',
        desc: `Hayatta olan NPC'lerin %${Math.round(cfg.CULL_RATIO * 100)}'sini haritadan siler. (Turda ${cfg.CULL_USES} hak, son ${fmtClock(cullUnlockLeft)}'da açılır)`,
      },
      {
        id: 'radar',
        key: 'R',
        icon: '📡',
        name: 'Radar Bombası',
        desc: `Tıklanan yere ${cfg.RADAR_FALL_TIME} sn'de düşer; ${cfg.RADAR_RADIUS} br içindeki gerçek oyuncu sayısını ${cfg.RADAR_SHOW_TIME} sn gösterir. (${cfg.RADAR_COOLDOWN} sn'de bir dolar)`,
      },
    ];
  }
  return [
    {
      id: 'disguise',
      icon: '👕',
      name: 'Kıyafet Değiştirme',
      desc: `Anında farklı kıyafet rengi ve şapkaya geçer. (Turda ${cfg.DISGUISE_USES} hak)`,
    },
    {
      id: 'smoke',
      icon: '🌫️',
      name: 'Sis Bombası',
      desc: `Bulunduğun yere ${cfg.SMOKE_DURATION} sn süren ${cfg.SMOKE_RADIUS} birimlik sis bırakır. (Hak sınırı yok, ${cfg.SMOKE_COOLDOWN} sn'de bir yeniden dolar)`,
    },
  ];
}

class Game {
  /**
   * @param {object} opts
   * @param {import('socket.io').Server} opts.io
   * @param {object} opts.room      server.js'deki oda nesnesi
   * @param {object} opts.config    server.js'deki CONFIG
   * @param {string} opts.seekerId  bu turun avcısı
   * @param {number} opts.round     tur numarası (1'den başlar)
   * @param {number} opts.totalRounds
   * @param {number} [opts.roundTime] tur süresi (sn); lobi ayarından gelir
   * @param {string} [opts.mapId]
   * @param {(result: object) => void} opts.onEnd  tur bitince çağrılır
   */
  constructor({ io, room, config, seekerId, round = 1, totalRounds = 1, roundTime, npcDensity, mapId = DEFAULT_MAP, onEnd }) {
    this.npcDensity = npcDensity || config.NPC_DENSITY_DEFAULT || 'normal';
    this.io = io;
    this.room = room;
    this.cfg = config;
    this.map = MAPS[mapId] || MAPS[DEFAULT_MAP];
    this.onEnd = onEnd;
    this.round = round;
    this.totalRounds = totalRounds;
    this.roundTime = roundTime || (config.ROUND_MINUTES_DEFAULT || 3) * 60;
    // Avcı yeteneği: 1:30 ile tur süresinin yarısından kısa olanı kalınca açılır
    this.cullUnlockLeft = Math.min(config.CULL_UNLOCK_LEFT, this.roundTime / 2);

    this.chars = [];            // Karıştırılmış karakter listesi
    this.charById = new Map();
    this.players = new Map();   // socketId -> { role, charId, alive }
    this.tasks = new Map();     // hider socketId -> görev durumu
    this.seekerId = seekerId;
    this.gunLockedUntil = 0;

    // Yetenek seçimi ve aktif yetenek durumları
    this.phase = 'pick';          // 'pick' | 'play'
    this.pickEndsAt = 0;
    this.skills = new Map();      // socketId -> { id, usesLeft }
    this.smokes = [];             // { id, x, y, r, expiresAt, totalMs }
    this.radars = [];             // { id, x, y, r, thrownAt, landAt, expiresAt, landed, count }
    this.radarReadyAt = 0;        // Avcının Radar Bombası yeniden dolma zamanı
    this.nextFxId = 1;
    this.seekerLookVer = new Map(); // charId -> avcıya gönderilmiş son görünüm sürümü
    this.seekerMouse = null;      // avcının bildirdiği son fare konumu { x, y }
    this.cullNotified = false;

    // 6 küçük sabit heykelin figür durumları
    this.statueStates = (this.map.statues || []).map((s) => ({
      id: s.id,
      shape: randInt(0, config.STATUE_SHAPES.length - 1),
      color: randInt(0, config.STATUE_COLORS.length - 1),
    }));

    // Elmaslar: { id, x, y, underRoof } (kişiye özel değil)
    this.diamonds = [];
    this.nextDiamondId = 1;
    this.diamondsDirty = false;
    this.diamondRespawns = [];    // { at } alınan elmasların 10 sn sonra yeniden çıkış zamanı

    // Çarpışma için engeller (çeşme ve 6 küçük heykel dahil)
    this.obstacles = [
      ...(this.map.fountain ? [{ type: 'circle', kind: 'fountain', x: this.map.fountain.x, y: this.map.fountain.y, r: this.map.fountain.r }] : []),
      ...(this.map.statues || []).map((s) => ({ type: 'circle', kind: 'statue', x: s.x, y: s.y, r: s.r })),
      ...this.map.obstacles,
    ];

    this.timer = null;
    this.lastTick = 0;
    this.startedAt = 0;
    this.endsAt = 0;
    this.ended = false;
  }

  statueFigure(st) {
    return {
      shape: this.cfg.STATUE_SHAPES[st.shape],
      color: this.cfg.STATUE_COLORS[st.color],
    };
  }

  statuesPayload() {
    const out = {};
    for (const st of this.statueStates) out[st.id] = this.statueFigure(st);
    return out;
  }

  // Hayatta olan saklananların karakter ID'leri ve ok renkleri: [[charId, colorHex], ...]
  // SADECE saklananlara gönderilir; avcıya ASLA gitmez ve oyuncu adı içermez.
  hiderArrowsPayload() {
    const palette = this.cfg.ARROW_COLORS || [];
    const out = [];
    let idx = 0;
    for (const [sid, info] of this.players) {
      if (info.role !== 'hider' || !info.alive || !info.charId) continue;
      const c = this.charById.get(info.charId);
      if (!c || c.dead) continue;
      const rp = this.room.players.get(sid);
      const fallback = palette.length ? palette[idx % palette.length].hex : '#e74c3c';
      const hex = (rp && rp.colorHex) || fallback;
      out.push([info.charId, hex]);
      idx++;
    }
    return out;
  }

  emitHiderArrows() {
    this.io.to(this.room.code).except(this.seekerId).emit('game:hiderArrows', this.hiderArrowsPayload());
  }

  // ======================================================
  //  KURULUM
  // ======================================================
  start() {
    const cfg = this.cfg;
    const playerIds = [...this.room.players.keys()];
    if (!playerIds.includes(this.seekerId)) this.seekerId = pick(playerIds);
    const hiderIds = shuffle(playerIds.filter((id) => id !== this.seekerId));

    const npcCount = npcCountFor(cfg, hiderIds.length, this.npcDensity);

    // Önce NPC'ler, sonra oyuncu karakterleri listenin İÇ kısmına rastgele yerleştirilir
    // (ilk ya da son sırada olmazlar)
    const list = [];
    for (let i = 0; i < npcCount; i++) list.push(this.makeChar(null));
    for (const sid of hiderIds) {
      const idx = randInt(1, list.length - 1); // 1..len-1 arası: baş ve sona asla değil
      list.splice(idx, 0, this.makeChar(sid));
    }

    // ID'ler karıştırılarak verilir
    const ids = shuffle(Array.from({ length: list.length }, (_, i) => i + 1));
    list.forEach((c, i) => { c.id = ids[i]; });

    this.chars = list;
    this.charById = new Map(list.map((c) => [c.id, c]));

    // Oyuncu kayıtları
    this.players.set(this.seekerId, { role: 'seeker', charId: null, alive: true });
    for (const c of list) {
      if (c.ownerId) this.players.set(c.ownerId, { role: 'hider', charId: c.id, alive: true });
    }

    // Görevler: elmaslar, VIP hedefleri
    for (const sid of hiderIds) {
      this.tasks.set(sid, { stage: 'diamonds', diamonds: 0, statue: false, vip: false, vipId: null, vipHits: 0, lastHitAt: 0 });
    }
    this.setupDiamonds(hiderIds.length);
    for (const sid of hiderIds) this.assignVip(sid);

    // Yetenek kayıtları: avcı tek yetenekle başlar, saklananlar seçim yapar
    for (const [sid, info] of this.players) {
      if (info.role === 'seeker') {
        this.skills.set(sid, { id: 'cull', usesLeft: cfg.CULL_USES });
      } else {
        this.skills.set(sid, { id: null, usesLeft: 0, readyAt: 0 });
      }
    }

    const now = Date.now();
    this.phase = 'pick';
    this.pickEndsAt = now + cfg.SKILL_PICK_TIME * 1000;
    this.startedAt = now;
    this.endsAt = 0;

    // Her oyuncuya kendi başlangıç verisini gönder
    const appearances = list.map((c) => [c.id, c.look.outfit, c.look.hat, c.look.skin]);
    const hiderArrows = this.hiderArrowsPayload();
    for (const [sid, info] of this.players) {
      const sk = this.skills.get(sid);
      const initPayload = {
        map: this.map,
        role: info.role,
        youCharId: info.charId,        // Saklanan sadece kendi ID'sini bilir; avcıya null
        charRadius: cfg.CHAR_RADIUS,
        shootRadius: cfg.SHOOT_RADIUS,
        peekRadius: cfg.PEEK_RADIUS,
        peekSendRadius: cfg.PEEK_SEND_RADIUS || 140,
        charFadeMs: cfg.CHAR_FADE_MS || 150,
        mouseSendHz: cfg.MOUSE_SEND_HZ,
        interactRange: cfg.INTERACT_RANGE,
        tickRate: cfg.TICK_RATE,
        appearances,
        statues: this.statuesPayload(),
        seekerName: this.nameOf(this.seekerId),
        round: this.round,
        totalRounds: this.totalRounds,
        roundTime: this.roundTime,
        diamondsNeeded: cfg.DIAMONDS_PER_HIDER,
        vipHitsNeeded: cfg.VIP_HITS,
        vipHitRange: cfg.VIP_HIT_RANGE,
        punchAnimMs: cfg.PUNCH_ANIM_MS,
        arrowCfg: {
          width: cfg.ARROW_WIDTH || 14,
          height: cfg.ARROW_HEIGHT || 12,
          headGap: cfg.ARROW_HEAD_GAP || 10,
          bobAmp: cfg.ARROW_BOB_AMP || 2.5,
        },
        phase: this.phase,
        pickTime: cfg.SKILL_PICK_TIME,
        skillOptions: skillOptionsFor(info.role, cfg, this.cullUnlockLeft),
        assignedSkill: sk && sk.id ? { skillId: sk.id, usesLeft: sk.usesLeft } : null,
        assignedSkills: info.role === 'seeker'
          ? [
              { skillId: 'cull', usesLeft: cfg.CULL_USES },
              { skillId: 'radar', usesLeft: null, cooldownMs: 0, cooldownTotalMs: cfg.RADAR_COOLDOWN * 1000 },
            ]
          : null,
        skillsCfg: {
          cullRatio: cfg.CULL_RATIO,
          cullUses: cfg.CULL_USES,
          cullUnlockLeft: this.cullUnlockLeft,
          puffTimeMs: cfg.PUFF_TIME_MS,
          radarRadius: cfg.RADAR_RADIUS,
          radarFallMs: cfg.RADAR_FALL_TIME * 1000,
          radarShowMs: cfg.RADAR_SHOW_TIME * 1000,
          radarCooldown: cfg.RADAR_COOLDOWN,
          smokeRadius: cfg.SMOKE_RADIUS,
          smokeDuration: cfg.SMOKE_DURATION,
          smokeCooldown: cfg.SMOKE_COOLDOWN,
          disguiseUses: cfg.DISGUISE_USES,
        },
        points: {
          diamond: cfg.DIAMOND_POINTS, statue: cfg.STATUE_POINTS, vip: cfg.VIP_POINTS,
          survive: cfg.SURVIVE_POINTS, catch: cfg.HIT_PLAYER_POINTS, npc: cfg.HIT_NPC_POINTS,
          vipHit: cfg.HIT_VIP_POINTS,
        },
      };
      // Hile koruması: saklanan karakterleri ve ok renkleri SADECE saklananlara gönderilir
      if (info.role === 'hider') {
        initPayload.hiderArrows = hiderArrows;
      }
      this.io.to(sid).emit('game:init', initPayload);
    }
    this.emitDiamonds();
    for (const sid of hiderIds) this.sendTasks(sid);
    this.broadcastScores();

    this.lastTick = Date.now();
    // Windows'ta zamanlayıcı çözünürlüğü kaba olabilir (~15 ms). Sık uyanıp vadesi gelen
    // tick'i çalıştırıyoruz; böylece ortalama aralık tam 1000/TICK_RATE ms kalır.
    const period = 1000 / cfg.TICK_RATE;
    this.nextTickAt = Date.now() + period;
    this.timer = setInterval(() => {
      const now = Date.now();
      if (now < this.nextTickAt) return;
      this.nextTickAt += period;
      if (now - this.nextTickAt > period * 4) this.nextTickAt = now + period; // çok geride kaldıysa sıfırla
      this.tick();
    }, 4);
  }

  stop() {
    this.ended = true;
    clearInterval(this.timer);
    this.timer = null;
  }

  makeChar(ownerId) {
    const cfg = this.cfg;
    const pos = this.randomFreePoint(Math.random() < 0.25 ? 'roof' : 'open');
    const c = {
      id: 0,
      ownerId,                       // Gerçek oyuncunun socket id'si; NPC için null. ASLA istemciye gitmez.
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      angle: rand(-Math.PI, Math.PI),
      moving: false,
      dead: false,
      deadAt: 0,
      underRoof: false,
      look: {
        outfit: randInt(0, cfg.OUTFIT_COLORS - 1),
        hat: Math.random() < 0.3 ? -1 : randInt(0, cfg.HAT_TYPES - 1), // -1 = şapkasız
        skin: randInt(0, cfg.SKIN_TONES - 1),
      },
      lookVersion: 0,
      input: { u: false, d: false, l: false, r: false },
      act: null,                     // Oyuncunun süren görevi { kind, dur, elapsed, diamondId?, targetId? }
      ai: null,
    };
    if (!ownerId) this.resetAi(c);
    return c;
  }

  resetAi(c) {
    c.ai = {
      state: 'idle',
      timer: rand(0, 1.5),           // Başta herkes aynı anda yola çıkmasın
      target: null,
      actionDur: 0,
      actionElapsed: 0,
      actionKind: 'wait',
      faceAngle: null,
      walkLeft: rand(1.2, 3.5),
      wander: rand(0, Math.PI * 2),
      wanderSpeed: rand(0.6, 1.4),
      bestDist: Infinity,
      stuck: 0,
      avoidSide: Math.random() < 0.5 ? 1 : -1,
      inspectStatueId: null,         // heykel incelemesi için ayırttığı heykel
      faceTimer: 0,
    };
  }

  // ======================================================
  //  HARİTA YARDIMCILARI
  // ======================================================
  isBlocked(x, y, pad) {
    for (const o of this.obstacles) {
      if (o.type === 'circle') {
        const dx = x - o.x, dy = y - o.y;
        const rr = o.r + pad;
        if (dx * dx + dy * dy < rr * rr) return true;
      } else if (x > o.x - pad && x < o.x + o.w + pad && y > o.y - pad && y < o.y + o.h + pad) {
        return true;
      }
    }
    return false;
  }

  isUnderRoof(x, y) {
    for (const r of this.map.roofs) if (pointInRect(x, y, r)) return true;
    return false;
  }

  /** kind: 'open' | 'roof' | 'any' */
  randomFreePoint(kind = 'any', near = null, nearRadius = 250) {
    const R = this.cfg.CHAR_RADIUS;
    const W = this.map.width, H = this.map.height;
    for (let tries = 0; tries < 200; tries++) {
      let x, y;
      if (kind === 'roof') {
        const roof = pick(this.map.roofs);
        x = rand(roof.x + R + 8, roof.x + roof.w - R - 8);
        y = rand(roof.y + R + 8, roof.y + roof.h - R - 8);
      } else if (near) {
        const a = rand(0, Math.PI * 2), d = rand(40, nearRadius);
        x = near.x + Math.cos(a) * d;
        y = near.y + Math.sin(a) * d;
      } else {
        x = rand(R + 10, W - R - 10);
        y = rand(R + 10, H - R - 10);
      }
      if (x < R + 10 || x > W - R - 10 || y < R + 10 || y > H - R - 10) continue;
      if (this.isBlocked(x, y, R + 6)) continue;
      if (kind === 'open' && this.isUnderRoof(x, y)) continue;
      return { x, y };
    }
    return { x: W / 2, y: H / 2 + 150 };
  }

  // ======================================================
  //  ELMASLAR (kişiye özel değil: toplam 3 × saklanan + 6)
  // ======================================================
  setupDiamonds(hiderCount) {
    const cfg = this.cfg;
    const total = hiderCount * cfg.DIAMONDS_PER_HIDER + cfg.BASE_DIAMONDS;
    // Yaklaşık %35'i çatı altında: önce tam sayıyı belirle, sonra karıştır
    const roofCount = Math.round(total * cfg.DIAMOND_ROOF_RATIO);
    const kinds = shuffle([...Array(roofCount).fill('roof'), ...Array(total - roofCount).fill('open')]);
    for (let i = 0; i < total; i++) {
      const d = { id: this.nextDiamondId++, x: 0, y: 0, underRoof: false };
      this.placeDiamond(d, kinds[i]);
      this.diamonds.push(d);
    }
    this.diamondsDirty = true;
  }

  placeDiamond(d, kind) {
    const R = this.cfg.CHAR_RADIUS;
    const f = this.map.fountain;
    for (let tries = 0; tries < 60; tries++) {
      const p = this.randomFreePoint(kind);
      if (this.isBlocked(p.x, p.y, R + 14)) continue;
      if (f && Math.hypot(p.x - f.x, p.y - f.y) < f.r + 30) continue;
      if (this.diamonds.some((o) => o !== d && Math.hypot(o.x - p.x, o.y - p.y) < 60)) continue;
      d.x = p.x; d.y = p.y;
      d.underRoof = this.isUnderRoof(rq(p.x), rq(p.y));
      return;
    }
    const p = this.randomFreePoint(kind);
    d.x = p.x; d.y = p.y;
    d.underRoof = this.isUnderRoof(rq(p.x), rq(p.y));
  }

  diamondsPayload() {
    const out = [];
    for (const d of this.diamonds) {
      out.push([d.id, rq(d.x), rq(d.y)]);
    }
    return out;
  }

  emitDiamonds() {
    this.diamondsDirty = false;
    // Bütün elmaslar (kapalı alanlardakiler dahil) herkese ve avcıya gönderilir
    this.io.to(this.room.code).emit('game:diamonds', this.diamondsPayload());
  }

  syncSeekerDiamonds() {
    // Avcı artık kapalı alandaki elmasları her zaman görür; ek filtreleme yok
  }

  nearestDiamond(x, y, filter) {
    let best = null, bestD = Infinity;
    for (const d of this.diamonds) {
      if (filter && !filter(d)) continue;
      const dist = Math.hypot(d.x - x, d.y - y);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best ? { d: best, dist: bestD } : null;
  }

  nearestStatue(x, y) {
    let best = null, bestD = Infinity;
    for (const s of this.map.statues || []) {
      const dist = Math.hypot(s.x - x, s.y - y);
      if (dist < bestD) { bestD = dist; best = s; }
    }
    return best ? { s: best, dist: bestD } : null;
  }

  // ======================================================
  //  GÖREVLER
  // ======================================================
  assignVip(sid) {
    const task = this.tasks.get(sid);
    if (!task || task.vip) return;
    const taken = new Set([...this.tasks.values()].map((t) => t.vipId).filter((v) => v !== null));
    const candidates = this.chars.filter((c) => !c.ownerId && !c.dead && !taken.has(c.id));
    task.vipId = candidates.length ? pick(candidates).id : null;
    task.vipHits = 0; // yeni hedef: vuruşlar sıfırdan başlar
  }

  sendTasks(sid) {
    const task = this.tasks.get(sid);
    if (!task) return;
    this.io.to(sid).emit('game:tasks', {
      stage: task.stage,
      diamonds: task.diamonds,
      diamondsNeeded: this.cfg.DIAMONDS_PER_HIDER,
      statue: task.statue,
      vip: task.vip,
      vipHits: task.vipHits,
      vipHitsNeeded: this.cfg.VIP_HITS,
      // Hedef sadece heykel görevi bittikten sonra görünür
      vipId: task.stage === 'vip' ? task.vipId : null,
    });
  }

  hint(sid, text) {
    this.io.to(sid).emit('game:hint', { text });
  }

  /**
   * Bir heykeli inceleyen karakterler.
   * activeOnly=false ise heykele yürüyüp yer ayırtmış NPC'ler de sayılır (NPC hedef seçerken).
   */
  inspectorsOf(statueId, activeOnly = true) {
    const out = new Set();
    for (const c of this.chars) {
      if (c.dead) continue;
      if (c.ownerId) {
        if (c.act && c.act.kind === 'inspect' && c.act.statueId === statueId) out.add(c.id);
      } else if (c.ai && c.ai.inspectStatueId === statueId) {
        if (!activeOnly || (c.ai.state === 'action' && c.ai.actionKind === 'inspect')) out.add(c.id);
      }
    }
    return out;
  }

  stat(sid) {
    const p = this.room.players.get(sid);
    if (!p) return null;
    if (!p.stats) {
      p.stats = {
        caughtPlayers: 0,
        hitNpcs: 0,
        hitVips: 0,
        diamonds: 0,
        statues: 0,
        vipsKilled: 0,
        survivedRounds: 0,
      };
    }
    return p.stats;
  }

  // charId aktif bir VIP ise (sahibi heykel görevini bitirmiş ve VIP henüz ölmemişse) { sid, task } döner
  activeVipEntry(charId) {
    for (const [sid, task] of this.tasks) {
      const p = this.players.get(sid);
      if (p && p.alive && task.stage === 'vip' && !task.vip && task.vipId === charId) {
        return { sid, task };
      }
    }
    return null;
  }

  addScore(sid, pts) {
    const p = this.room.players.get(sid);
    if (!p) return;
    p.score += pts;
    p.roundScore = (p.roundScore || 0) + pts;
  }

  cycleStatue(statueId) {
    const st = this.statueStates.find((s) => s.id === statueId);
    if (!st) return;
    st.shape = (st.shape + 1) % this.cfg.STATUE_SHAPES.length;
    st.color = (st.color + 1) % this.cfg.STATUE_COLORS.length;
    this.io.to(this.room.code).emit('game:statue', { id: st.id, ...this.statueFigure(st) });
  }

  // Saklanan E'ye bastı
  handleInteract(socketId) {
    if (this.ended || this.phase !== 'play') return;
    const info = this.players.get(socketId);
    if (!info || info.role !== 'hider' || !info.alive) return;
    const c = this.charById.get(info.charId);
    const task = this.tasks.get(socketId);
    if (!c || c.dead || !task) return;
    if (c.act) return; // zaten bir görev yapıyor

    const cfg = this.cfg;

    if (task.stage === 'diamonds') {
      // Elmas anında alınır: bekleme/ilerleme halkası yok, karakter durmaz (yürürken de alınabilir)
      const near = this.nearestDiamond(c.x, c.y);
      if (!near || near.dist > cfg.INTERACT_RANGE) return this.hint(socketId, 'Yakında elmas yok');
      this.collectDiamond(near.d, socketId, task);
      return;
    } else if (task.stage === 'statue') {
      const near = this.nearestStatue(c.x, c.y);
      if (!near || near.dist > near.s.r + cfg.INTERACT_RANGE) return this.hint(socketId, 'Heykelin yanına git');
      // Aynı heykeli aynı anda en fazla 3 karakter inceler
      if (this.inspectorsOf(near.s.id).size >= cfg.STATUE_MAX_INSPECTORS) return this.hint(socketId, 'Heykelin başı dolu, biraz bekle');
      c.act = { kind: 'inspect', dur: cfg.STATUE_INSPECT_TIME, elapsed: 0, statueId: near.s.id };
      c.angle = Math.atan2(near.s.y - c.y, near.s.x - c.x);
    } else if (task.stage === 'vip') {
      this.hitVip(c, socketId, task);
      return;
    } else {
      this.hint(socketId, 'Bütün görevlerin tamam. Hayatta kal!');
    }
    c.vx = c.vy = 0;
  }

  // VIP'ye 1 vuruş (E). 3. vuruşta VIP ölür. VIP kaçmaz, normal davranışına devam eder.
  hitVip(c, sid, task) {
    const cfg = this.cfg;
    const now = Date.now();
    const t = this.charById.get(task.vipId);
    if (!t || t.dead) {
      this.assignVip(sid);
      this.sendTasks(sid);
      return this.hint(sid, 'Hedefine yaklaş');
    }
    if (Math.hypot(t.x - c.x, t.y - c.y) > cfg.VIP_HIT_RANGE) return this.hint(sid, 'Hedefine yaklaş');
    if (now - task.lastHitAt < cfg.VIP_HIT_COOLDOWN_MS) return; // iki vuruş arası en az 0,5 sn
    task.lastHitAt = now;
    task.vipHits++;
    c.angle = Math.atan2(t.y - c.y, t.x - c.x);

    // Yumruk (vuran) ve sarsılma (VIP) animasyonu herkese gider; avcıya sadece görebildiği kısım
    const ang = r2(c.angle);
    this.io.to(this.room.code).except(this.seekerId).emit('game:punch', { a: c.id, v: t.id, ang });
    const seeA = this.isVisibleToSeeker(c, now), seeV = this.isVisibleToSeeker(t, now);
    if (seeA || seeV) this.io.to(this.seekerId).emit('game:punch', { a: seeA ? c.id : null, v: seeV ? t.id : null, ang });

    if (task.vipHits >= cfg.VIP_HITS) {
      task.vip = true;      // killChar'dan önce: aynı hedef için yeniden atama yapılmasın
      task.stage = 'done';
      this.killChar(t);
      this.addScore(sid, cfg.VIP_POINTS);
      const st = this.stat(sid);
      if (st) st.vipsKilled++;
      this.io.to(sid).emit('game:notify', { kind: 'good', sfx: 'vipKill', text: `🎯 VIP öldürüldü +${cfg.VIP_POINTS}. Bütün görevler tamam!` });
      this.sendTasks(sid);
      this.broadcastScores();
      this.checkAllTasksDone();
    } else {
      this.io.to(sid).emit('game:sfx', { name: 'punch' });
      this.sendTasks(sid);
    }
  }

  cancelAct(c, notifyText) {
    if (!c.act) return;
    c.act = null;
    if (notifyText && c.ownerId) this.hint(c.ownerId, notifyText);
  }

  // Elması anında alır (E'ye basıldığı an)
  collectDiamond(d, sid, task) {
    const cfg = this.cfg;
    this.addScore(sid, cfg.DIAMOND_POINTS);
    const st = this.stat(sid);
    if (st) st.diamonds++;
    task.diamonds++;
    // Alınan elmas silinir; 10 sn sonra haritanın rastgele bir yerinde yenisi çıkar
    this.diamonds = this.diamonds.filter((x) => x.id !== d.id);
    this.diamondRespawns.push({ at: Date.now() + cfg.DIAMOND_RESPAWN_MS });
    this.diamondsDirty = true;
    if (task.diamonds >= cfg.DIAMONDS_PER_HIDER) task.stage = 'statue';
    // Parlama efekti ve "ding" sesi sadece elması alan oyuncuya gider (avcıya ipucu vermez)
    this.io.to(sid).emit('game:sparkle', { x: rq(d.x), y: rq(d.y) });
    this.io.to(sid).emit('game:notify', { kind: 'good', sfx: 'diamond', text: `💎 Elmas +${cfg.DIAMOND_POINTS} (${task.diamonds}/${cfg.DIAMONDS_PER_HIDER})` });
    this.sendTasks(sid);
    this.broadcastScores();
  }

  completePlayerAct(c) {
    const act = c.act;
    c.act = null;
    const sid = c.ownerId;
    const task = this.tasks.get(sid);
    if (!task) return;
    const cfg = this.cfg;

    if (act.kind === 'inspect') {
      const st = (this.map.statues || []).find((s) => s.id === act.statueId);
      if (!st || Math.hypot(st.x - c.x, st.y - c.y) > st.r + cfg.INTERACT_RANGE + 12) return;
      this.addScore(sid, cfg.STATUE_POINTS);
      const pst = this.stat(sid);
      if (pst) pst.statues++;
      task.statue = true;
      task.stage = 'vip';
      if (task.vipId === null || !this.charById.get(task.vipId) || this.charById.get(task.vipId).dead) this.assignVip(sid);
      this.cycleStatue(st.id);
      this.io.to(sid).emit('game:notify', { kind: 'good', sfx: 'statue', text: `🗿 Heykel incelendi +${cfg.STATUE_POINTS}. Hedefin işaretlendi!` });
    }
    this.sendTasks(sid);
    this.broadcastScores();
    this.checkAllTasksDone();
  }

  // Bir karakter ölür (avcı vurdu ya da VIP öldürüldü)
  killChar(c, silentVip = false) {
    c.dead = true;
    c.deadAt = Date.now();
    c.moving = false;
    c.vx = c.vy = 0;
    c.act = null;

    if (c.ownerId) {
      const info = this.players.get(c.ownerId);
      if (info) info.alive = false;
      this.emitHiderArrows();
    } else if (!silentVip) {
      // Ölen NPC birinin VIP'siyse o saklanana yeni hedef atanır
      for (const [sid, task] of this.tasks) {
        if (task.vipId === c.id && !task.vip) {
          task.vipId = null;
          this.assignVip(sid);
          this.sendTasks(sid);
          if (task.stage === 'vip') {
            this.io.to(sid).emit('game:notify', { kind: 'warn', text: 'Hedefin değişti!' });
            this.hint(sid, 'Hedefin değişti!');
          }
        }
      }
    }
  }

  // ======================================================
  //  NPC YAPAY ZEKÂSI (%24 çatı, %10 bakma, %15 heykel inceleme, %51 açık alan)
  //  İlerleme halkası SADECE iki durumda görünür: heykel incelerken ve çatı altında
  //  kıyafet değiştirirken. Diğer bütün beklemelerde NPC halkasız durur.
  // ======================================================
  chooseNpcTarget(c) {
    const ai = c.ai;
    const cfg = this.cfg;
    const roll = Math.random();
    ai.faceAngle = null;
    ai.actionKind = 'wait';
    ai.inspectStatueId = null;

    if (roll < cfg.NPC_ROOF_CHANCE) {
      // %24: çatılı bir alanın içine girer; %30'unda 1,2 sn durup kıyafet değiştirir
      ai.target = this.randomFreePoint('roof');
      if (Math.random() < cfg.NPC_ROOF_DISGUISE_CHANCE) {
        ai.actionDur = cfg.NPC_DISGUISE_PAUSE;
        ai.actionKind = 'disguise';
      } else {
        ai.actionDur = rand(1, 4);
      }
    } else if (roll < cfg.NPC_ROOF_CHANCE + cfg.NPC_ADMIRE_CHANCE) {
      // %10: bir elmasın ya da heykelin yanına yürür, 1–3 sn durur ve bakar (dokunmaz, halka yok)
      const pt = this.pickAdmirePoint();
      if (pt) {
        ai.target = pt.pos;
        ai.faceAngle = pt.faceAngle;
        ai.actionDur = rand(cfg.NPC_ADMIRE_MIN, cfg.NPC_ADMIRE_MAX);
      } else {
        ai.target = this.randomFreePoint('open');
        ai.actionDur = rand(1, 4);
      }
    } else if (roll < cfg.NPC_ROOF_CHANCE + cfg.NPC_ADMIRE_CHANCE + cfg.NPC_INSPECT_CHANCE) {
      // %15: boş yeri olan bir heykelin yanına yürür, yüzünü döner, 3 sn inceler
      // (oyuncunun incelemesiyle aynı halka; ama heykel DEĞİŞMEZ)
      const pt = this.pickInspectPoint(c);
      if (pt) {
        ai.target = pt.pos;
        ai.faceAngle = pt.faceAngle;
        ai.actionDur = cfg.STATUE_INSPECT_TIME;
        ai.actionKind = 'inspect';
        ai.inspectStatueId = pt.statueId; // yer ayırtır (aynı heykelde en fazla 3 karakter)
      } else {
        ai.target = this.randomFreePoint('open');
        ai.actionDur = rand(1, 4);
      }
    } else {
      // Kalan %51: açık alanda rastgele bir nokta
      ai.target = this.randomFreePoint('open');
      ai.actionDur = rand(1, 4);
    }

    ai.state = 'walk';
    ai.bestDist = Infinity;
    ai.stuck = 0;
  }

  // Boş yeri olan (en fazla 3 inceleyen) bir heykelin hemen yanında, başka
  // inceleyenlerle üst üste binmeyen bir nokta seçer.
  pickInspectPoint(c) {
    const cfg = this.cfg;
    const R = cfg.CHAR_RADIUS;
    const W = this.map.width, H = this.map.height;
    const free = (this.map.statues || [])
      .filter((s) => this.inspectorsOf(s.id, false).size < cfg.STATUE_MAX_INSPECTORS)
      .sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y));
    for (const s of free) {
      // Bu heykel için başkalarının ayırttığı / kullandığı noktalar
      const taken = [];
      for (const o of this.chars) {
        if (o === c || o.dead) continue;
        if (o.ai && o.ai.inspectStatueId === s.id && o.ai.target) taken.push(o.ai.target);
        else if (o.act && o.act.kind === 'inspect' && o.act.statueId === s.id) taken.push({ x: o.x, y: o.y });
      }
      const dist = s.r + R + 4; // heykel kenarına ~16 birim (sınır 25)
      const base = rand(0, Math.PI * 2);
      for (let i = 0; i < 10; i++) {
        const a = base + (i * Math.PI * 2) / 10;
        const tx = s.x + Math.cos(a) * dist;
        const ty = s.y + Math.sin(a) * dist;
        if (tx < R + 8 || tx > W - R - 8 || ty < R + 8 || ty > H - R - 8) continue;
        if (this.isBlocked(tx, ty, R + 1)) continue;
        if (taken.some((p) => Math.hypot(p.x - tx, p.y - ty) < R * 2 + 2)) continue;
        return { statueId: s.id, pos: { x: tx, y: ty }, faceAngle: Math.atan2(s.y - ty, s.x - tx) };
      }
    }
    return null;
  }

  // NPC'nin heykel kenarına uzaklığı (incelemek için <= NPC_INSPECT_MAX_EDGE olmalı)
  statueEdgeDist(c, statueId) {
    const s = (this.map.statues || []).find((x) => x.id === statueId);
    if (!s) return Infinity;
    return Math.hypot(c.x - s.x, c.y - s.y) - s.r;
  }

  // NPC'nin heykel incelemesi biter/başlamaz: yer ayırtmayı bırakıp yeni hedef arar
  abandonInspect(c) {
    c.ai.inspectStatueId = null;
    c.ai.actionKind = 'wait';
    c.ai.state = 'idle';
    c.ai.timer = rand(0.2, 0.8);
  }

  // Elmas ya da heykel yanında 1–3 sn durup bakmak için nokta (halkasız)
  pickAdmirePoint() {
    const R = this.cfg.CHAR_RADIUS;
    const W = this.map.width, H = this.map.height;
    const spots = [];
    for (const d of this.diamonds) spots.push({ x: d.x, y: d.y, dist: 16 });
    for (const s of this.map.statues || []) spots.push({ x: s.x, y: s.y, dist: s.r + R + 6 });
    if (!spots.length) return null;
    const chosen = pick(spots);
    const base = rand(0, Math.PI * 2);
    for (let i = 0; i < 8; i++) {
      const a = base + (i * Math.PI) / 4;
      const tx = chosen.x + Math.cos(a) * chosen.dist;
      const ty = chosen.y + Math.sin(a) * chosen.dist;
      if (tx < R + 8 || tx > W - R - 8 || ty < R + 8 || ty > H - R - 8) continue;
      if (this.isBlocked(tx, ty, R + 2)) continue;
      return { pos: { x: tx, y: ty }, faceAngle: Math.atan2(chosen.y - ty, chosen.x - tx) };
    }
    return null;
  }

  // NPC sadece çatı altında kıyafet değiştirir. Elmaslara dokunmaz; heykeli inceler
  // ('inspect') ama heykel değişmez: heykeli sadece gerçek oyuncunun incelemesi değiştirir.
  completeNpcAction(c) {
    if (c.ai.actionKind === 'disguise') this.changeLook(c);
    c.ai.inspectStatueId = null;
  }

  // Hedefe varınca: incelemeyse önce yüzünü heykele döner; kıyafetse çatı altında olmalı
  arriveNpc(c) {
    const ai = c.ai;
    const cfg = this.cfg;
    ai.actionElapsed = 0;
    if (ai.actionKind === 'inspect') {
      const busy = this.inspectorsOf(ai.inspectStatueId, true).size >= cfg.STATUE_MAX_INSPECTORS;
      if (busy || this.statueEdgeDist(c, ai.inspectStatueId) > cfg.NPC_INSPECT_MAX_EDGE) {
        return this.abandonInspect(c); // heykelin yanına varamadı / yer yok: inceleme başlamaz
      }
      ai.state = 'face';
      ai.faceTimer = 0;
      return;
    }
    if (ai.actionKind === 'disguise' && !this.isUnderRoof(rq(c.x), rq(c.y))) {
      ai.actionKind = 'wait'; // çatı altına giremedi: halkasız normal bekleme
    }
    ai.state = 'action';
  }

  // Önündeki bir engele doğru yürüyorsa yönünü saptırır
  avoidance(c, heading, distToTarget = Infinity) {
    const R = this.cfg.CHAR_RADIUS;
    // Hedef bir engelin hemen yanındaysa (ör. heykel) sonda hedefi geçmesin
    const probe = Math.min(26, distToTarget);
    const px = c.x + Math.cos(heading) * probe;
    const py = c.y + Math.sin(heading) * probe;
    if (!this.isBlocked(px, py, R)) return 0;
    return c.ai.avoidSide * 1.1;
  }

  updateNpc(c, dt, now) {
    const ai = c.ai;
    const cfg = this.cfg;
    c.vx = 0;
    c.vy = 0;

    switch (ai.state) {
      case 'idle':
        ai.timer -= dt;
        if (ai.timer <= 0) this.chooseNpcTarget(c);
        break;

      case 'pause': // Kısa duraklama (0,3–1,1 sn)
        ai.timer -= dt;
        if (ai.timer <= 0) ai.state = 'walk';
        break;

      case 'face': { // Heykel incelemesinden önce yüzünü heykele döner
        ai.faceTimer += dt;
        const st = (this.map.statues || []).find((x) => x.id === ai.inspectStatueId);
        if (st) ai.faceAngle = Math.atan2(st.y - c.y, st.x - c.x);
        const diff = this.turnToward(c, ai.faceAngle, dt, 6);
        if (this.statueEdgeDist(c, ai.inspectStatueId) > cfg.NPC_INSPECT_MAX_EDGE) { this.abandonInspect(c); break; }
        if (Math.abs(diff) < 0.12 || ai.faceTimer > 1.2) {
          if (this.inspectorsOf(ai.inspectStatueId, true).size >= cfg.STATUE_MAX_INSPECTORS) { this.abandonInspect(c); break; }
          c.angle = ai.faceAngle;
          ai.state = 'action';
          ai.actionElapsed = 0;
        }
        break;
      }

      case 'action': { // Hedefte bekleme / bakma / heykel inceleme / çatı altı kıyafet değiştirme
        ai.actionElapsed += dt;
        if (ai.faceAngle !== null) this.turnToward(c, ai.faceAngle, dt, 4);
        // İnceleme sırasında heykelden 25 birimden fazla itilirse inceleme biter (halka kaybolur)
        if (ai.actionKind === 'inspect' && this.statueEdgeDist(c, ai.inspectStatueId) > cfg.NPC_INSPECT_MAX_EDGE) {
          this.abandonInspect(c);
          break;
        }
        if (ai.actionElapsed >= ai.actionDur) {
          this.completeNpcAction(c);
          ai.state = 'idle';
          ai.timer = 0;
        }
        break;
      }

      case 'walk': {
        const dx = ai.target.x - c.x;
        const dy = ai.target.y - c.y;
        const dist = Math.hypot(dx, dy);

        if (dist < 7) {
          this.arriveNpc(c);
          break;
        }

        // Kısa kısa yürüme: belli aralıklarla durur
        ai.walkLeft -= dt;
        if (ai.walkLeft <= 0 && dist > 40) {
          ai.state = 'pause';
          ai.timer = rand(0.3, 1.1);
          ai.walkLeft = rand(1.2, 3.5);
          break;
        }

        // Takılma kontrolü: hedefe yaklaşamıyorsa yeni hedef seç
        if (dist < ai.bestDist - 1) {
          ai.bestDist = dist;
          ai.stuck = 0;
        } else {
          ai.stuck += dt;
          if (ai.stuck > 2.5) {
            // Hedefe varamadı (ör. kalabalık): inceleme/kıyafet başlamaz, yeni hedef seçer
            ai.avoidSide *= -1;
            ai.inspectStatueId = null;
            ai.actionKind = 'wait';
            ai.state = 'idle';
            ai.timer = rand(0.2, 0.8);
            break;
          }
        }

        // Hafif kıvrılarak yürür (dümdüz değil), hedefe yaklaştıkça düzleşir
        ai.wander += dt * ai.wanderSpeed;
        const wobble = Math.sin(ai.wander) * 0.45 * Math.min(1, dist / 120);
        let desired = Math.atan2(dy, dx) + wobble;
        desired += this.avoidance(c, desired, dist);

        const diff = this.turnToward(c, desired, dt, 4.5);
        // Keskin dönüşte yavaşla ki büyük daireler çizmesin
        const speed = cfg.CHAR_SPEED * (Math.abs(diff) > 1.2 ? 0.35 : 1);
        c.vx = Math.cos(c.angle) * speed;
        c.vy = Math.sin(c.angle) * speed;
        break;
      }
    }
  }

  // Açıyı yumuşakça hedef açıya döndürür; kalan farkı döner
  turnToward(c, target, dt, rate) {
    const diff = wrapAngle(target - c.angle);
    const max = rate * dt;
    c.angle = wrapAngle(c.angle + clamp(diff, -max, max));
    return diff;
  }

  updatePlayerChar(c, dt) {
    if (this.phase !== 'play') {
      // Yetenek seçimi sırasında oyuncular hareket edemez
      c.vx = c.vy = 0;
      return;
    }
    if (c.act) {
      // Görev sırasında karakter durur
      c.vx = c.vy = 0;
      c.act.elapsed += dt;
      if (c.act.elapsed >= c.act.dur) this.completePlayerAct(c);
      return;
    }
    const i = c.input;
    let mx = (i.r ? 1 : 0) - (i.l ? 1 : 0);
    let my = (i.d ? 1 : 0) - (i.u ? 1 : 0);
    if (mx || my) {
      const len = Math.hypot(mx, my);
      mx /= len;
      my /= len;
      c.angle = Math.atan2(my, mx);
    }
    c.vx = mx * this.cfg.CHAR_SPEED;
    c.vy = my * this.cfg.CHAR_SPEED;
  }

  // ======================================================
  //  FİZİK
  // ======================================================
  resolveCollisions() {
    const R = this.cfg.CHAR_RADIUS;
    const W = this.map.width, H = this.map.height;
    const alive = this.chars.filter((c) => !c.dead);
    const minD = R * 2;
    const minD2 = minD * minD;

    // Karakterler birbirini hafifçe iter. Izgara (grid) tabanlı: her karakter sadece
    // kendi hücresi ve 8 komşu hücredeki karakterlerle kontrol edilir (~100+ karakterde O(n)).
    const cell = minD;
    const cols = Math.ceil(W / cell) + 1;
    const grid = new Map();
    for (let i = 0; i < alive.length; i++) {
      const c = alive[i];
      const key = Math.floor(c.y / cell) * cols + Math.floor(c.x / cell);
      const bucket = grid.get(key);
      if (bucket) bucket.push(i); else grid.set(key, [i]);
    }
    for (let i = 0; i < alive.length; i++) {
      const a = alive[i];
      const cx0 = Math.floor(a.x / cell), cy0 = Math.floor(a.y / cell);
      for (let gy = cy0 - 1; gy <= cy0 + 1; gy++) {
        for (let gx = cx0 - 1; gx <= cx0 + 1; gx++) {
          const bucket = grid.get(gy * cols + gx);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue; // her çift bir kez
            const b = alive[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= minD2) continue;
            let d = Math.sqrt(d2);
            if (d < 0.001) {
              const ang = Math.random() * Math.PI * 2;
              dx = Math.cos(ang); dy = Math.sin(ang); d = 1;
            }
            const push = (minD - d) * 0.5 * this.cfg.PUSH_SOFTNESS;
            const nx = dx / d, ny = dy / d;
            a.x -= nx * push; a.y -= ny * push;
            b.x += nx * push; b.y += ny * push;
          }
        }
      }
    }

    // Engeller ve harita sınırı (bunlar sert)
    for (const c of alive) {
      for (const o of this.obstacles) {
        if (o.type === 'circle') {
          const dx = c.x - o.x, dy = c.y - o.y;
          const rr = o.r + R;
          const d2 = dx * dx + dy * dy;
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2) || 0.001;
            c.x = o.x + (dx / d) * rr;
            c.y = o.y + (dy / d) * rr;
          }
        } else {
          const cx = clamp(c.x, o.x, o.x + o.w);
          const cy = clamp(c.y, o.y, o.y + o.h);
          const dx = c.x - cx, dy = c.y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 < R * R) {
            if (d2 > 0.0001) {
              const d = Math.sqrt(d2);
              c.x = cx + (dx / d) * R;
              c.y = cy + (dy / d) * R;
            } else {
              // Merkez dikdörtgenin içinde: en yakın kenardan dışarı it
              const left = c.x - o.x, right = o.x + o.w - c.x;
              const top = c.y - o.y, bottom = o.y + o.h - c.y;
              const m = Math.min(left, right, top, bottom);
              if (m === left) c.x = o.x - R;
              else if (m === right) c.x = o.x + o.w + R;
              else if (m === top) c.y = o.y - R;
              else c.y = o.y + o.h + R;
            }
          }
        }
      }
      c.x = clamp(c.x, R, W - R);
      c.y = clamp(c.y, R, H - R);
    }
  }

  // ======================================================
  //  DÖNGÜ
  // ======================================================
  tick() {
    if (this.ended) return;
    const now = Date.now();
    const dt = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;

    // Yetenek seçimi süresi dolunca seçmeyenlere rastgele atanır ve tur başlar
    if (this.phase === 'pick' && now >= this.pickEndsAt) {
      this.beginPlayPhase();
    }

    // Süresi dolan sisler temizlenir
    if (this.smokes.length) {
      this.smokes = this.smokes.filter((s) => now < s.expiresAt);
    }

    // Radar bombaları: 0,8 sn'de düşer, düştüğü anda 130 br içindeki canlı saklananları sayar, 3 sn görünür
    if (this.radars.length) {
      for (const rb of this.radars) {
        if (!rb.landed && now >= rb.landAt) {
          rb.landed = true;
          let count = 0;
          for (const c of this.chars) {
            if (c.dead || !c.ownerId) continue; // Sadece hayatta olan gerçek oyuncular (NPC ve VIP sayılmaz)
            if (Math.hypot(c.x - rb.x, c.y - rb.y) <= rb.r) count++;
          }
          rb.count = count;
          this.notify('warn', '📡 Radar!', { sfx: 'radar' });
        }
      }
      this.radars = this.radars.filter((rb) => now < rb.expiresAt);
    }

    // Alınan elmasların 10 sn sonra yenilenmesi
    if (this.diamondRespawns.length) {
      let spawned = false;
      const pending = [];
      for (const r of this.diamondRespawns) {
        if (now >= r.at) {
          const d = { id: this.nextDiamondId++, x: 0, y: 0, underRoof: false };
          this.placeDiamond(d, Math.random() < this.cfg.DIAMOND_ROOF_RATIO ? 'roof' : 'open');
          this.diamonds.push(d);
          spawned = true;
        } else pending.push(r);
      }
      if (spawned) {
        this.diamondRespawns = pending;
        this.diamondsDirty = true;
      }
    }

    // Kalan süre min(1:30, tur süresinin yarısı) veya altına inince avcı yeteneği açılır
    if (this.phase === 'play' && !this.cullNotified) {
      const leftSec = Math.max(0, Math.ceil((this.endsAt - now) / 1000));
      if (leftSec <= this.cullUnlockLeft) {
        this.cullNotified = true;
        this.notify('warn', 'Avcının yeteneği açıldı');
      }
    }

    for (const c of this.chars) {
      if (c.dead) continue;
      c.px = c.x;
      c.py = c.y;
      if (c.ownerId) this.updatePlayerChar(c, dt);
      else this.updateNpc(c, dt, now);
      c.x += c.vx * dt;
      c.y += c.vy * dt;
    }
    if (this.ended) return; // bir görev tamamlanınca tur bitmiş olabilir

    this.resolveCollisions();

    for (const c of this.chars) {
      if (c.dead) continue;
      const moved = Math.hypot(c.x - c.px, c.y - c.py);
      c.moving = moved > 0.4 && (c.vx !== 0 || c.vy !== 0);
      // Ağ paketindeki yuvarlanmış (tam sayı) koordinatla aynı sonucu vermek için rq kullanılır
      c.underRoof = this.isUnderRoof(rq(c.x), rq(c.y));
      if (c.ai && c.ai.state === 'action' && c.ai.actionKind === 'inspect' && c.ai.inspectStatueId !== null) {
        const st = (this.map.statues || []).find((x) => x.id === c.ai.inspectStatueId);
        if (st) c.angle = Math.atan2(st.y - c.y, st.x - c.x);
      }
    }

    // Cesetler belli süre sonra kaybolur
    const corpseMs = this.cfg.CORPSE_TIME_MS;
    if (this.chars.some((c) => c.dead && now - c.deadAt > corpseMs)) {
      this.chars = this.chars.filter((c) => !(c.dead && now - c.deadAt > corpseMs));
      this.charById = new Map(this.chars.map((c) => [c.id, c]));
    }

    if (this.diamondsDirty) this.emitDiamonds();
    else this.syncSeekerDiamonds();
    this.broadcastState(now);

    if (this.phase === 'play' && now >= this.endsAt) this.endRound('time');
  }

  // NPC ilerleme halkası SADECE: heykel kenarına <= 25 birimde heykel incelerken
  // ya da çatı altında kıyafet değiştirirken. Diğer bütün beklemelerde halka yok.
  npcShowsRing(c) {
    const ai = c.ai;
    if (!ai || ai.state !== 'action') return false;
    if (ai.actionKind === 'inspect') {
      return ai.inspectStatueId !== null && this.statueEdgeDist(c, ai.inspectStatueId) <= this.cfg.NPC_INSPECT_MAX_EDGE;
    }
    if (ai.actionKind === 'disguise') return this.isUnderRoof(rq(c.x), rq(c.y));
    return false;
  }

  // Ağ formatı (kısa dizi, hepsi tam sayı): [id, x, y, açıDerece, bayraklar?, ilerleme?]
  //   x, y: tam sayıya yuvarlanmış konum; açı: 0..359 derece
  //   bayraklar: 1 = yürüyor, 2 = ölü; 0 ise ve halka yoksa 5. eleman HİÇ gönderilmez
  //   ilerleme: 0..100 eylem halkası yüzdesi; halka yoksa 6. eleman HİÇ gönderilmez
  // Görünüm (kıyafet/şapka/ten) burada yoktur: başta game:init ile, sonra sadece
  // değiştiğinde game:look ile gönderilir. Gerçek oyuncu olup olmadığı ASLA gönderilmez.
  serializeChar(c) {
    let flags = 0;
    if (c.moving) flags |= 1;
    if (c.dead) flags |= 2;
    let prog = -1;
    if (!c.dead) {
      if (c.act) prog = Math.min(1, c.act.elapsed / c.act.dur);
      else if (this.npcShowsRing(c)) prog = Math.min(1, c.ai.actionElapsed / c.ai.actionDur);
    }
    const e = [c.id, rq(c.x), rq(c.y), toDeg(c.angle)];
    if (flags || prog >= 0) e.push(flags);
    if (prog >= 0) e.push(Math.round(prog * 100));
    return e;
  }

  isInSmoke(x, y, now) {
    for (const s of this.smokes) {
      if (now < s.expiresAt && Math.hypot(x - s.x, y - s.y) <= s.r) return true;
    }
    return false;
  }

  isInPeek(x, y, radius = this.cfg.PEEK_RADIUS) {
    if (this.phase !== 'play' || !this.seekerMouse) return false;
    if (!this.isUnderRoof(this.seekerMouse.x, this.seekerMouse.y)) return false;
    return Math.hypot(x - this.seekerMouse.x, y - this.seekerMouse.y) <= radius;
  }

  // forSend=true: ağda nişangâhın 140 br çevresi gönderilir (istemci gerçek farede 80 br'ye kırpar)
  // forSend=false: atış ve puf kontrolü sunucuda yine 80 br'ye göre yapılır
  isVisibleToSeeker(c, now, forSend = true) {
    // Aktif VIP'ler kapalı alanlarda da avcıya görünür
    if (!c.dead && !c.ownerId && this.activeVipEntry(c.id)) return true;
    if (this.isInSmoke(rq(c.x), rq(c.y), now)) return false;
    const peekR = forSend ? (this.cfg.PEEK_SEND_RADIUS || 140) : this.cfg.PEEK_RADIUS;
    if (c.underRoof && !this.isInPeek(rq(c.x), rq(c.y), peekR)) return false;
    return true;
  }

  broadcastState(now) {
    const full = [];
    const forSeeker = [];
    const seekerLooks = [];
    for (const c of this.chars) {
      const e = this.serializeChar(c);
      full.push(e);
      if (this.isVisibleToSeeker(c, now)) {
        forSeeker.push(e);
        if ((c.lookVersion || 0) !== (this.seekerLookVer.get(c.id) || 0)) {
          this.seekerLookVer.set(c.id, c.lookVersion || 0);
          seekerLooks.push([c.id, c.look.outfit, c.look.hat, c.look.skin]);
        }
      }
    }

    const left = this.phase === 'pick'
      ? this.roundTime
      : Math.max(0, Math.ceil((this.endsAt - now) / 1000));
    const pickLeft = this.phase === 'pick' ? Math.max(0, Math.ceil((this.pickEndsAt - now) / 1000)) : 0;

    const smokes = this.smokes.length
      ? this.smokes.map((s) => [s.id, s.x, s.y, Math.max(0, s.expiresAt - now), s.totalMs])
      : undefined;

    const fallMs = this.cfg.RADAR_FALL_TIME * 1000;
    const showMs = this.cfg.RADAR_SHOW_TIME * 1000;
    const radarsPublic = this.radars.length
      ? this.radars.map((rb) => [
          rb.id,
          rb.x,
          rb.y,
          rb.landed ? 1 : 0,
          rb.landed ? Math.max(0, rb.expiresAt - now) : Math.max(0, rb.landAt - now),
          rb.landed ? showMs : fallMs,
        ])
      : undefined;
    const radarsSeeker = this.radars.length
      ? this.radars.map((rb) => [
          rb.id,
          rb.x,
          rb.y,
          rb.landed ? 1 : 0,
          rb.landed ? Math.max(0, rb.expiresAt - now) : Math.max(0, rb.landAt - now),
          rb.landed ? showMs : fallMs,
          rb.landed ? rb.count : null,
        ])
      : undefined;

    // Aktif VIP'ler: sadece [charId, kalanCan] olarak avcıya gider (hangi saklanana ait olduğu gönderilmez)
    const seekerVips = [];
    for (const [sid, task] of this.tasks) {
      const p = this.players.get(sid);
      if (!p || !p.alive || task.stage !== 'vip' || task.vip || !task.vipId) continue;
      const vc = this.charById.get(task.vipId);
      if (!vc || vc.dead) continue;
      const hpLeft = Math.max(0, this.cfg.VIP_HITS - (task.vipHits || 0));
      seekerVips.push([vc.id, hpLeft]);
    }

    const common = { left, phase: this.phase }; // (istemcinin kullanmadığı zaman damgası gönderilmez)
    if (this.phase === 'pick') common.pickLeft = pickLeft;
    if (smokes) common.sm = smokes;

    const code = this.room.code;
    const hiderMsg = { ...common, c: full };
    if (radarsPublic) hiderMsg.rb = radarsPublic;
    this.io.to(code).except(this.seekerId).emit('game:state', hiderMsg);

    const seekerMsg = {
      ...common,
      c: forSeeker,
      g: Math.max(0, this.gunLockedUntil - now), // Silah kilit süresi (ms)
    };
    if (radarsSeeker) seekerMsg.rb = radarsSeeker;
    if (seekerVips.length) seekerMsg.vips = seekerVips;
    if (seekerLooks.length) seekerMsg.looks = seekerLooks;
    this.io.to(this.seekerId).emit('game:state', seekerMsg);
  }

  // ======================================================
  //  YETENEKLER
  // ======================================================
  handlePickSkill(socketId, skillId) {
    if (this.ended || this.phase !== 'pick') return;
    const info = this.players.get(socketId);
    const sk = this.skills.get(socketId);
    if (!info || info.role === 'seeker' || !sk || sk.id) return;
    const opts = skillOptionsFor(info.role, this.cfg, this.cullUnlockLeft);
    if (!opts.some((o) => o.id === skillId)) return;
    this.assignSkill(socketId, skillId);
    this.checkPickComplete();
  }

  assignSkill(sid, skillId) {
    const sk = this.skills.get(sid);
    if (!sk) return;
    const cfg = this.cfg;
    sk.id = skillId;
    // Sis bombasının hak sınırı yok (usesLeft: null); her atıştan sonra 15 sn yeniden dolar
    sk.usesLeft = skillId === 'disguise'
      ? cfg.DISGUISE_USES
      : skillId === 'smoke'
        ? null
        : cfg.CULL_USES;
    sk.readyAt = 0;
    // Seçilen yetenek sadece sahibine gider; kimse başkasının yeteneğini görmez
    this.io.to(sid).emit('game:skillPicked', {
      skillId: sk.id,
      usesLeft: sk.usesLeft,
    });
  }

  skillStatePayload(sk, now = Date.now()) {
    const out = { skillId: sk.id, usesLeft: sk.usesLeft };
    if (sk.id === 'smoke') {
      out.cooldownMs = Math.max(0, (sk.readyAt || 0) - now);
      out.cooldownTotalMs = this.cfg.SMOKE_COOLDOWN * 1000;
    }
    return out;
  }

  checkPickComplete() {
    if (this.phase !== 'pick' || this.ended) return;
    const allPicked = [...this.players.entries()]
      .filter(([, info]) => info.role === 'hider')
      .every(([sid]) => {
        const sk = this.skills.get(sid);
        return sk && sk.id;
      });
    if (allPicked) this.beginPlayPhase();
  }

  beginPlayPhase() {
    if (this.phase !== 'pick' || this.ended) return;
    const now = Date.now();
    for (const [sid, info] of this.players) {
      if (info.role !== 'hider') continue;
      const sk = this.skills.get(sid);
      if (sk && !sk.id) {
        const opts = skillOptionsFor(info.role, this.cfg, this.cullUnlockLeft);
        this.assignSkill(sid, pick(opts).id);
      }
    }
    this.phase = 'play';
    this.startedAt = now;
    this.endsAt = now + this.roundTime * 1000;
    this.io.to(this.room.code).emit('game:playStart', { roundTime: this.roundTime });
  }

  handleUseSkill(socketId, payload) {
    if (this.ended || this.phase !== 'play') return;
    const info = this.players.get(socketId);
    const sk = this.skills.get(socketId);
    if (!info || !info.alive || !sk || !sk.id) return;

    const cfg = this.cfg;
    const now = Date.now();

    if (info.role === 'seeker') {
      const isRadar = payload && (payload.skillId === 'radar' || (typeof payload.x === 'number' && typeof payload.y === 'number'));
      if (isRadar) {
        if (typeof payload.x !== 'number' || typeof payload.y !== 'number' || !isFinite(payload.x) || !isFinite(payload.y)) return;
        if (now < this.radarReadyAt) return;
        const cx = clamp(payload.x, 0, this.map.width);
        const cy = clamp(payload.y, 0, this.map.height);
        const cdMs = cfg.RADAR_COOLDOWN * 1000;
        const fallMs = cfg.RADAR_FALL_TIME * 1000;
        const showMs = cfg.RADAR_SHOW_TIME * 1000;
        this.radarReadyAt = now + cdMs;
        this.radars.push({
          id: this.nextFxId++,
          x: rq(cx),
          y: rq(cy),
          r: cfg.RADAR_RADIUS,
          thrownAt: now,
          landAt: now + fallMs,
          expiresAt: now + fallMs + showMs,
          landed: false,
          count: null,
        });
        this.io.to(socketId).emit('game:skillState', {
          skillId: 'radar',
          usesLeft: null,
          cooldownMs: cdMs,
          cooldownTotalMs: cdMs,
        });
        return;
      }

      if (sk.id !== 'cull' || sk.usesLeft <= 0) return;
      const leftSec = Math.max(0, Math.ceil((this.endsAt - now) / 1000));
      if (leftSec > this.cullUnlockLeft) return;

      sk.usesLeft--;
      const aliveNpcs = this.chars.filter((c) => !c.dead && !c.ownerId);
      const count = Math.floor(aliveNpcs.length * cfg.CULL_RATIO);
      const victims = shuffle([...aliveNpcs]).slice(0, count);
      const victimIds = new Set(victims.map((v) => v.id));

      const reassignedSids = [];
      for (const [sid, task] of this.tasks) {
        if (victimIds.has(task.vipId) && !task.vip) {
          task.vipId = null;
          reassignedSids.push(sid);
        }
      }

      const allPuffs = victims.map((v) => ({ id: v.id, x: rq(v.x), y: rq(v.y) }));
      const seekerPuffs = victims
        .filter((v) => this.isVisibleToSeeker(v, now, false))
        .map((v) => ({ id: v.id, x: rq(v.x), y: rq(v.y) }));

      if (victims.length) {
        this.chars = this.chars.filter((c) => !victimIds.has(c.id));
        for (const id of victimIds) {
          this.charById.delete(id);
          this.seekerLookVer.delete(id);
        }
      }

      for (const sid of reassignedSids) {
        this.assignVip(sid);
        this.sendTasks(sid);
        const t = this.tasks.get(sid);
        if (t && t.stage === 'vip') {
          this.io.to(sid).emit('game:notify', { kind: 'warn', text: 'Hedefin değişti!' });
          this.hint(sid, 'Hedefin değişti!');
        }
      }

      this.io.to(this.room.code).except(this.seekerId).emit('game:puffs', allPuffs);
      this.io.to(this.seekerId).emit('game:puffs', seekerPuffs);
      this.notify('warn', "🧹 Avcı kalabalığı azalttı! NPC'lerin %20'si gitti");
      this.io.to(socketId).emit('game:skillState', {
        skillId: sk.id,
        usesLeft: sk.usesLeft,
      });
      return;
    }

    // Saklanan yetenekleri
    const c = this.charById.get(info.charId);
    if (!c || c.dead) return;

    if (sk.id === 'disguise') {
      if (sk.usesLeft <= 0) return;
      sk.usesLeft--;
      this.changeLook(c, now);
      this.io.to(socketId).emit('game:skillState', {
        skillId: sk.id,
        usesLeft: sk.usesLeft,
      });
      this.io.to(socketId).emit('game:sfx', { name: 'notify' });
    } else if (sk.id === 'smoke') {
      // Bekleme süresi sis atıldığı anda başlar (sis kaybolduktan sonra değil)
      if (now < (sk.readyAt || 0)) return;
      sk.readyAt = now + cfg.SMOKE_COOLDOWN * 1000;
      const durMs = cfg.SMOKE_DURATION * 1000;
      const sm = {
        id: this.nextFxId++,
        x: rq(c.x),
        y: rq(c.y),
        r: cfg.SMOKE_RADIUS,
        expiresAt: now + durMs,
        totalMs: durMs,
      };
      this.smokes.push(sm);
      this.io.to(this.room.code).emit('game:sfx', { name: 'smoke' });
      this.io.to(socketId).emit('game:skillState', this.skillStatePayload(sk, now));
    }
  }

  changeLook(c, now = Date.now()) {
    const cfg = this.cfg;
    if (cfg.OUTFIT_COLORS > 1) {
      let o = randInt(0, cfg.OUTFIT_COLORS - 1);
      while (o === c.look.outfit) o = randInt(0, cfg.OUTFIT_COLORS - 1);
      c.look.outfit = o;
    }
    if (cfg.HAT_TYPES > 0) {
      let h = Math.random() < 0.25 ? -1 : randInt(0, cfg.HAT_TYPES - 1);
      let guard = 0;
      while (h === c.look.hat && guard++ < 20) {
        h = Math.random() < 0.25 ? -1 : randInt(0, cfg.HAT_TYPES - 1);
      }
      c.look.hat = h;
    }
    c.lookVersion = (c.lookVersion || 0) + 1;
    const payload = [c.id, c.look.outfit, c.look.hat, c.look.skin];
    this.io.to(this.room.code).except(this.seekerId).emit('game:look', payload);
    if (this.isVisibleToSeeker(c, now)) {
      this.seekerLookVer.set(c.id, c.lookVersion);
      this.io.to(this.seekerId).emit('game:look', payload);
    }
  }

  // ======================================================
  //  OYUNCU OLAYLARI
  // ======================================================
  handleInput(socketId, input) {
    if (this.ended || this.phase !== 'play') return;
    const info = this.players.get(socketId);
    if (!info || info.role !== 'hider' || !info.alive) return;
    const c = this.charById.get(info.charId);
    if (!c || c.dead) return;
    const src = input || {};
    c.input = { u: !!src.u, d: !!src.d, l: !!src.l, r: !!src.r };
    // Hareket edilirse süren görev iptal olur
    if (c.act && (c.input.u || c.input.d || c.input.l || c.input.r)) this.cancelAct(c, 'Görev iptal edildi');
  }

  handleSeekerMouse(socketId, pos) {
    if (this.ended || socketId !== this.seekerId) return;
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || !isFinite(pos.x) || !isFinite(pos.y)) {
      this.seekerMouse = null;
      return;
    }
    this.seekerMouse = {
      x: clamp(pos.x, 0, this.map.width),
      y: clamp(pos.y, 0, this.map.height),
    };
  }

  handleShoot(socketId, x, y) {
    if (this.ended || this.phase !== 'play' || socketId !== this.seekerId) return;
    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return;
    const now = Date.now();
    if (now < this.gunLockedUntil) return;

    const cfg = this.cfg;
    this.io.to(this.room.code).emit('game:shot', { x: rq(x), y: rq(y) });

    // Tıklanan noktaya en yakın, 22 birim içindeki GÖRÜNÜR karakter (sis dışı, çatı altındaysa nişangâh 80 br yakını)
    let best = null;
    let bestD = cfg.SHOOT_RADIUS;
    for (const c of this.chars) {
      if (c.dead || !this.isVisibleToSeeker(c, now, false)) continue;
      const d = Math.hypot(c.x - x, c.y - y);
      if (d <= bestD) { bestD = d; best = c; }
    }

    if (!best) {
      this.gunLockedUntil = now + cfg.MISS_LOCK_MS;
      return;
    }

    const victimOwner = best.ownerId;
    const activeVip = !victimOwner ? this.activeVipEntry(best.id) : null;

    if (victimOwner) {
      this.killChar(best);
      // Gerçek oyuncu yakalandı
      this.addScore(this.seekerId, cfg.HIT_PLAYER_POINTS);
      const st = this.stat(this.seekerId);
      if (st) st.caughtPlayers++;
      const name = this.nameOf(victimOwner);
      this.io.to(victimOwner).emit('game:eliminated', { by: this.nameOf(this.seekerId) });
      this.notify('caught', `Avcı ${name} adlı oyuncuyu yakaladı!`, { victimId: victimOwner });
      this.broadcastScores();
      this.checkAllCaught();
      this.checkAllTasksDone();
    } else if (activeVip) {
      // Aktif VIP vuruldu: ağır ceza (-10), 2 sn silah kilidi, sahibine tam canlı (3/3) yeni aktif VIP
      const { sid, task } = activeVip;
      this.killChar(best, true);
      this.addScore(this.seekerId, cfg.HIT_VIP_POINTS);
      const st = this.stat(this.seekerId);
      if (st) st.hitVips++;
      this.gunLockedUntil = now + cfg.NPC_HIT_LOCK_MS;
      task.vipId = null;
      this.assignVip(sid);
      this.sendTasks(sid);
      this.io.to(sid).emit('game:notify', { kind: 'warn', text: 'Hedefin değişti!' });
      this.hint(sid, 'Hedefin değişti!');
      this.notify('npc', '😬 Avcı bir VIP\'yi vurdu (−10)');
      this.broadcastScores();
    } else {
      this.killChar(best);
      // Masum NPC (aktif olmayan VIP dahil: -2 puan)
      this.addScore(this.seekerId, cfg.HIT_NPC_POINTS);
      const st = this.stat(this.seekerId);
      if (st) st.hitNpcs++;
      this.gunLockedUntil = now + cfg.NPC_HIT_LOCK_MS;
      this.notify('npc', `Avcı masum bir NPC vurdu (${cfg.HIT_NPC_POINTS})`);
      this.broadcastScores();
    }
  }

  // Oyun sırasında bir oyuncu odadan çıkarsa
  onPlayerLeave(socketId, name) {
    const info = this.players.get(socketId);
    if (!info) return;
    this.players.delete(socketId);

    if (info.role === 'seeker') {
      this.endRound('seekerLeft');
      return;
    }

    // Saklananın karakteri NPC'ye dönüşür, kimse fark etmez
    const c = this.charById.get(info.charId);
    if (c && !c.dead) {
      c.ownerId = null;
      c.act = null;
      c.input = { u: false, d: false, l: false, r: false };
      this.resetAi(c);
    }
    this.tasks.delete(socketId);
    this.skills.delete(socketId);
    this.emitHiderArrows();
    this.notify('info', `${name} oyundan ayrıldı`);
    this.broadcastScores();
    this.checkAllCaught();
    this.checkAllTasksDone();
    this.checkPickComplete();
  }

  aliveHiders() {
    return [...this.players.entries()].filter(([, p]) => p.role === 'hider' && p.alive);
  }

  checkAllCaught() {
    if (this.ended) return;
    const hiders = [...this.players.values()].filter((p) => p.role === 'hider');
    if (hiders.length > 0 && this.aliveHiders().length === 0) this.endRound('caught');
  }

  checkAllTasksDone() {
    if (this.ended) return;
    const alive = this.aliveHiders();
    if (alive.length === 0) return;
    const allDone = alive.every(([sid]) => {
      const t = this.tasks.get(sid);
      return t && t.stage === 'done';
    });
    if (allDone) this.endRound('tasks');
  }

  // ======================================================
  //  TUR SONU
  // ======================================================
  endRound(reason) {
    if (this.ended) return;
    // Süre bitene kadar hayatta kalan saklananlar bonus alır
    if (reason !== 'seekerLeft') {
      for (const [sid] of this.aliveHiders()) {
        this.addScore(sid, this.cfg.SURVIVE_POINTS);
        const st = this.stat(sid);
        if (st) st.survivedRounds++;
      }
    }
    this.broadcastState(Date.now()); // son durum (ör. son vuruş) herkese ulaşsın
    this.stop();
    this.broadcastScores();
    const result = {
      reason,
      reasonText: REASON_TEXT[reason] || 'Tur bitti',
      round: this.round,
      totalRounds: this.totalRounds,
      players: this.summary(),
    };
    if (this.onEnd) this.onEnd(result);
  }

  summary() {
    const out = [];
    for (const p of this.room.players.values()) {
      const info = this.players.get(p.id);
      const task = this.tasks.get(p.id);
      out.push({
        id: p.id,
        name: p.name,
        role: info ? info.role : 'hider',
        alive: info ? info.alive : false,
        roundScore: p.roundScore || 0,
        score: p.score,
        tasks: task ? { diamonds: task.diamonds, diamondsNeeded: this.cfg.DIAMONDS_PER_HIDER, statue: task.statue, vip: task.vip } : null,
      });
    }
    return out;
  }

  // ======================================================
  //  BİLDİRİM / PUAN
  // ======================================================
  nameOf(socketId) {
    const p = this.room.players.get(socketId);
    return p ? p.name : '?';
  }

  // kind: 'caught' | 'npc' | 'info'  → renk istemcide role göre seçilir
  notify(kind, text, extra = {}) {
    this.io.to(this.room.code).emit('game:notify', { kind, text, ...extra });
  }

  broadcastScores() {
    const list = [];
    for (const p of this.room.players.values()) {
      const info = this.players.get(p.id);
      list.push({
        id: p.id,
        name: p.name,
        score: p.score,
        roundScore: p.roundScore || 0,
        role: info ? info.role : 'hider',
        out: info ? !info.alive : false,
      });
    }
    list.sort((a, b) => b.score - a.score);
    this.io.to(this.room.code).emit('game:scores', list);
  }
}

module.exports = { Game, npcCountFor };
