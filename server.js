// ============================================================
//  Act Like NPC - Sunucu
//  Node.js + Express + Socket.io
//  Veritabanı yok: odalar ve oyuncular bellekte tutulur.
// ============================================================

// ---------- OYUN AYARLARI ----------
// Sonraki parçalarda gelecek bütün ayarlar (süreler, puanlar vb.) buraya eklenir.
const CONFIG = {
  PORT: process.env.PORT || 3000,

  // Lobi
  MAX_PLAYERS: 10,          // Bir odadaki en fazla oyuncu sayısı
  MIN_PLAYERS_TO_START: 2,  // Oyunun başlaması için gereken en az oyuncu
  NICK_MAX_LENGTH: 16,      // Takma ad uzunluk sınırı
  ROOM_CODE_LENGTH: 4,      // Oda kodu uzunluğu
  // 0/O ve 1/I gibi karıştırılabilecek karakterler yok
  ROOM_CODE_CHARS: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',

  // Oyun döngüsü
  TICK_RATE: 20,            // Sunucu saniyede kaç kez günceller
  WS_COMPRESS_THRESHOLD: 1024, // Bu boyuttan (bayt) büyük ağ mesajları sıkıştırılır
  MAP_ID: 'square',         // game/maps.js içindeki harita

  // Karakterler
  CHAR_RADIUS: 12,          // Çarpışma yarıçapı (birim)
  CHAR_SPEED: 55,           // Herkes aynı hızda yürür (birim/sn)
  PUSH_SOFTNESS: 0.6,       // Karakterlerin birbirini itme yumuşaklığı (0..1)
  OUTFIT_COLORS: 9,         // Kıyafet rengi seçenekleri
  HAT_TYPES: 6,             // Şapka seçenekleri (+ şapkasız)
  SKIN_TONES: 5,            // Ten rengi seçenekleri

  // Saklanan ok işareti renkleri (10 renk; lobide her renk sadece bir oyuncuya ait olabilir)
  ARROW_COLORS: [
    { id: 'red',    label: 'Kırmızı',    hex: '#e74c3c' },
    { id: 'orange', label: 'Turuncu',    hex: '#f39c12' },
    { id: 'yellow', label: 'Sarı',       hex: '#f1c40f' },
    { id: 'green',  label: 'Yeşil',      hex: '#2ecc71' },
    { id: 'cyan',   label: 'Camgöbeği',  hex: '#00d2d3' },
    { id: 'blue',   label: 'Mavi',       hex: '#3498db' },
    { id: 'purple', label: 'Mor',        hex: '#9b59b6' },
    { id: 'pink',   label: 'Pembe',      hex: '#fd79a8' },
    { id: 'white',  label: 'Beyaz',      hex: '#ffffff' },
    { id: 'brown',  label: 'Kahverengi', hex: '#8d5524' },
  ],
  ARROW_WIDTH: 14,          // Ok genişliği (birim)
  ARROW_HEIGHT: 12,         // Ok yüksekliği (birim)
  ARROW_HEAD_GAP: 10,       // Karakterin başının üstündeki boşluk (birim)
  ARROW_BOB_AMP: 2.5,       // Hafif yukarı-aşağı salınım genliği (birim)

  // Temel NPC sayısı = NPC_BASE + NPC_PER_HIDER × saklanan sayısı, en fazla NPC_MAX
  // (1 saklanan → 52, 2 → 64, 4 → 88, 6 → 112, 9 → 148). Lobi yoğunluk ayarı bununla çarpılır.
  NPC_BASE: 40,
  NPC_PER_HIDER: 12,
  NPC_MAX: 150,
  // Lobide liderin seçtiği NPC yoğunluğu: temel sayının katı ve çarpımdan sonraki üst sınır
  NPC_DENSITY: {
    low: { label: 'Az', mult: 0.75, max: 150 },
    normal: { label: 'Normal', mult: 1, max: 150 },
    high: { label: 'Çok', mult: 1.5, max: 200 },
  },
  NPC_DENSITY_ORDER: ['low', 'normal', 'high'],
  NPC_DENSITY_DEFAULT: 'normal',
  NPC_ROOF_CHANCE: 0.24,            // Çatılı alana gitme oranı
  NPC_ROOF_DISGUISE_CHANCE: 0.3,    // Çatıya giren NPC'nin kıyafet değiştirme olasılığı
  NPC_DISGUISE_PAUSE: 1.2,          // NPC çatı altında kıyafet değiştirirken bekleme (sn)
  NPC_ADMIRE_CHANCE: 0.1,           // Elmas/heykel yanında durup bakma oranı (halka yok, dokunmaz)
  NPC_ADMIRE_MIN: 1,                // Bakma süresi en az (sn)
  NPC_ADMIRE_MAX: 3,                // Bakma süresi en çok (sn)
  NPC_INSPECT_CHANCE: 0.15,         // Heykele gidip 3 sn inceleme oranı (heykel değişmez); kalan %51 açık alan
  NPC_INSPECT_MAX_EDGE: 25,         // İnceleme için heykel kenarına en fazla bu kadar yakın olmalı (birim)
  STATUE_MAX_INSPECTORS: 3,         // Aynı heykeli aynı anda en fazla bu kadar karakter inceler

  // Avcı ve kapalı alan görüşü
  SHOOT_RADIUS: 22,         // Tıklanan noktaya bu mesafedeki en yakın karakter vurulur
  PEEK_RADIUS: 80,          // Kapalı alan üzerinde nişangâhın açtığı görünür delik ve atış yarıçapı (birim)
  PEEK_SEND_RADIUS: 140,    // Sunucunun avcıya gönderdiği çatı altı karakter yarıçapı (gecikmesiz takip için)
  CHAR_FADE_MS: 150,        // Görünür alana girip çıkan karakterlerin belirme/kaybolma süresi (ms)
  MOUSE_SEND_HZ: 20,        // Avcının fare konumunu sunucuya gönderme sıklığı (Hz)
  HIT_PLAYER_POINTS: 5,     // Gerçek oyuncuyu vurunca
  HIT_NPC_POINTS: -2,       // Masum NPC vurunca
  HIT_VIP_POINTS: -10,      // Aktif bir VIP'yi vurunca (ağır ceza)
  NPC_HIT_LOCK_MS: 2000,    // NPC veya VIP vurunca silah kilidi
  MISS_LOCK_MS: 500,        // Boşa ateşte silah kilidi
  CORPSE_TIME_MS: 15000,    // Cesetlerin yerde kalma süresi

  // Lobi ayarları (sadece lider değiştirir)
  ROUNDS_MIN: 1,
  ROUNDS_MAX: 10,
  ROUNDS_DEFAULT: 3,                // Tur sayısı varsayılanı
  ROUND_MINUTES_OPTIONS: [1, 2, 3, 4, 5],
  ROUND_MINUTES_DEFAULT: 3,         // Tur süresi varsayılanı (dakika)

  // Turlar (ortam değişkenleri sadece otomatik testlerde süreleri kısaltmak için)
  ROUND_TIME_OVERRIDE: envNum('ROUND_TIME', 0),      // >0 ise lobi ayarı yerine bu tur süresi (sn) kullanılır (test)
  SKILL_PICK_TIME: envNum('SKILL_PICK_TIME', 10),    // Tur başı yetenek seçimi süresi (saniye)
  ROUND_END_SCREEN_MS: envNum('ROUND_END_MS', 7000), // Tur sonu ekranı
  FINAL_SCREEN_MS: envNum('FINAL_MS', 15000),        // Oyun sonu liderlik tablosu ekranı (15 sn)

  // Yetenekler
  CULL_RATIO: 0.2,                  // Kalabalığı Azalt: hayatta olan NPC'lerin %20'si silinir
  CULL_USES: 1,                     // Tur başına Kalabalığı Azalt hakkı
  CULL_UNLOCK_LEFT: envNum('CULL_UNLOCK_LEFT', 90),  // Kalan süre <= min(90 sn, tur süresinin yarısı) olunca açılır
  PUFF_TIME_MS: 450,                // Silinen NPC puf efekti süresi (ms)
  RADAR_RADIUS: 130,                // Radar Bombası yarıçapı (birim)
  RADAR_FALL_TIME: 0.8,             // Radar Bombası düşme süresi (sn)
  RADAR_SHOW_TIME: 3,               // Radar Bombası sayısının görünme süresi (sn)
  RADAR_COOLDOWN: envNum('RADAR_COOLDOWN', 15),      // Radar Bombası bekleme süresi (sn); sınırsız hak
  DISGUISE_USES: 2,                 // Turda kıyafet değiştirme hakkı
  SMOKE_RADIUS: 90,                 // Sis bombası yarıçapı (birim)
  SMOKE_DURATION: 10,               // Sis süresi (sn)
  SMOKE_COOLDOWN: 15,               // Sis atıldığı andan itibaren yeniden dolma süresi (sn); hak sınırı yok

  // Görevler
  DIAMONDS_PER_HIDER: 3,    // Her saklananın alması gereken elmas
  BASE_DIAMONDS: 6,         // Haritadaki elmas sayısı = 3 × saklanan sayısı + 6
  DIAMOND_RESPAWN_MS: 10000,// Alınan elmasın yerine yeni elmas çıkma süresi (ms)
  DIAMOND_ROOF_RATIO: 0.4,  // Elmasların yaklaşık %40'ı kapalı alanlarda çıkar
  STATUE_INSPECT_TIME: 3,   // Heykel inceleme süresi (sn); NPC'ler de aynı süre inceler
  VIP_HITS: 3,              // VIP kaç vuruşta ölür
  VIP_HIT_RANGE: 30,        // VIP'ye vurmak için en fazla uzaklık (birim)
  VIP_HIT_COOLDOWN_MS: 500, // İki vuruş arası en az bekleme (ms)
  PUNCH_ANIM_MS: 260,       // Yumruk / sarsılma animasyonu süresi (ms)
  INTERACT_RANGE: 40,       // E tuşunun çalıştığı mesafe (birim)
  STATUE_SHAPES: ['circle', 'square', 'triangle', 'star'],
  STATUE_COLORS: ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6', '#e67e22'],

  // Puanlar (saklanan)
  DIAMOND_POINTS: 3,
  STATUE_POINTS: 4,
  VIP_POINTS: 5,
  SURVIVE_POINTS: 2,        // Tur sonuna kadar hayatta kalmak
};

function envNum(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game, npcCountFor } = require('./game/Game');

const app = express();
const server = http.createServer(app);
// WebSocket mesaj sıkıştırması: ~4 KB'lık durum paketleri ~1,7 KB'a iner (200 NPC'de).
// Sadece eşikten büyük mesajlar sıkıştırılır; küçük olaylar olduğu gibi gider.
const io = new Server(server, { perMessageDeflate: { threshold: CONFIG.WS_COMPRESS_THRESHOLD } });

app.use(express.static(path.join(__dirname, 'public')));

// ---------- BELLEK ----------
// rooms: Map<odaKodu, Oda>
// Oda: { code, leaderId, state: 'lobby' | 'playing', players: Map<socketId, Oyuncu> }
// Oyuncu: { id, name, ready, score }
const rooms = new Map();

// ---------- YARDIMCILAR ----------
function generateRoomCode() {
  const chars = CONFIG.ROOM_CODE_CHARS;
  let code;
  do {
    code = '';
    for (let i = 0; i < CONFIG.ROOM_CODE_LENGTH; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

function sanitizeNick(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, CONFIG.NICK_MAX_LENGTH);
}

// Aynı ada sahip iki kişi gelirse ikinciye sayı ekler: Ali, Ali2, Ali3...
function uniqueName(room, name) {
  const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let n = 2;
  while (taken.has((name + n).toLowerCase())) n++;
  return name + n;
}

function defaultSettings() {
  return {
    rounds: CONFIG.ROUNDS_DEFAULT,
    roundMinutes: CONFIG.ROUND_MINUTES_DEFAULT,
    npcDensity: CONFIG.NPC_DENSITY_DEFAULT,
  };
}

function resolveArrowColor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return CONFIG.ARROW_COLORS.find(
    (c) => c.id === v || c.hex.toLowerCase() === v || c.label.toLowerCase() === v,
  ) || null;
}

function pickFreeArrowColor(room, preferredRaw = null, ignoreId = null) {
  const taken = new Set();
  for (const [pid, p] of room.players) {
    if (pid !== ignoreId && p.color) taken.add(p.color);
  }
  const pref = resolveArrowColor(preferredRaw);
  if (pref && !taken.has(pref.id)) return pref;
  return CONFIG.ARROW_COLORS.find((c) => !taken.has(c.id)) || CONFIG.ARROW_COLORS[0];
}

function roomSnapshot(room) {
  // Bir turda 1 avcı olur; geri kalanlar saklanan
  const hiders = Math.max(0, room.players.size - 1);
  return {
    code: room.code,
    leaderId: room.leaderId,
    state: room.state,
    settings: { ...room.settings },
    settingsLimits: {
      roundsMin: CONFIG.ROUNDS_MIN,
      roundsMax: CONFIG.ROUNDS_MAX,
      minuteOptions: CONFIG.ROUND_MINUTES_OPTIONS,
      densityOptions: CONFIG.NPC_DENSITY_ORDER.map((id) => ({ id, label: CONFIG.NPC_DENSITY[id].label })),
    },
    arrowColors: CONFIG.ARROW_COLORS,
    // Lobide gösterilir: "Bu ayarla yaklaşık 64 NPC olacak"
    npcEstimate: npcCountFor(CONFIG, hiders, room.settings.npcDensity),
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      score: p.score,
      color: p.color,
      colorHex: p.colorHex,
    })),
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', roomSnapshot(room));
}

function getPlayerRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return null;
  return rooms.get(code) || null;
}

function removePlayer(socket, reason) {
  const room = getPlayerRoom(socket);
  if (!room) return;

  const leaving = room.players.get(socket.id);
  room.players.delete(socket.id);
  socket.leave(room.code);
  socket.data.roomCode = null;

  // Oyun sürerken çıkarsa oyun mantığı haberdar edilir
  if (room.game) room.game.onPlayerLeave(socket.id, leaving ? leaving.name : '?');

  if (room.players.size === 0) {
    // Oda boşalınca silinir
    if (room.game) room.game.stop();
    room.game = null;
    rooms.delete(room.code);
    return;
  }

  // Lider çıkarsa liderlik sıradaki oyuncuya geçer
  if (room.leaderId === socket.id) {
    room.leaderId = room.players.keys().next().value;
  }

  broadcastRoom(room);
  if (room.state === 'lobby') maybeStartGame(room);
  else if (room.state === 'playing' && room.players.size < CONFIG.MIN_PLAYERS_TO_START) {
    endGame(room, 'Yeterli oyuncu kalmadı, lobiye dönüldü');
  }
}

function maybeStartGame(room) {
  if (room.state !== 'lobby') return;
  if (room.players.size < CONFIG.MIN_PLAYERS_TO_START) return;
  const allReady = [...room.players.values()].every((p) => p.ready);
  if (!allReady) return;
  startGame(room);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function emptyStats() {
  return {
    caughtPlayers: 0,
    hitNpcs: 0,
    hitVips: 0,
    diamonds: 0,
    statues: 0,
    vipsKilled: 0,
    survivedRounds: 0,
  };
}

// ---------- MAÇ: lobide seçilen tur sayısı kadar tur, avcılık sırayla döner ----------
function startGame(room) {
  room.state = 'playing';
  for (const p of room.players.values()) {
    p.score = 0;
    p.roundScore = 0;
    p.stats = emptyStats();
  }
  const s = room.settings || defaultSettings();
  // Avcılık sırası maç başında rastgele belirlenir; tur sayısı oyuncu sayısından fazlaysa sıra baştan başlar
  room.match = {
    order: shuffle([...room.players.keys()]),
    roundIndex: 0,
    totalRounds: s.rounds,
    roundTime: CONFIG.ROUND_TIME_OVERRIDE || s.roundMinutes * 60,
    npcDensity: s.npcDensity,
    timer: null,
    inFinal: false,
    returned: new Set(),
  };
  broadcastRoom(room);
  io.to(room.code).emit('game:started', roomSnapshot(room));
  startRound(room);
}

// Bu turun avcısı: sıradaki oyuncu (sıra döngüsel: A, B, C, A, B...)
function seekerForRound(room, index) {
  const m = room.match;
  m.order = m.order.filter((id) => room.players.has(id)); // ayrılanlar sıradan düşer
  if (!m.order.length) return null;
  return m.order[index % m.order.length];
}

function startRound(room) {
  const m = room.match;
  if (!m || room.state !== 'playing') return;
  if (m.roundIndex >= m.totalRounds) return finishMatch(room);
  const seekerId = seekerForRound(room, m.roundIndex);
  if (!seekerId) return finishMatch(room);

  for (const p of room.players.values()) p.roundScore = 0;
  room.game = new Game({
    io,
    room,
    config: CONFIG,
    mapId: CONFIG.MAP_ID,
    seekerId,
    round: m.roundIndex + 1,
    totalRounds: m.totalRounds,
    roundTime: m.roundTime,
    npcDensity: m.npcDensity,
    onEnd: (result) => onRoundEnd(room, result),
  });
  room.game.start();
}

function onRoundEnd(room, result) {
  const m = room.match;
  if (room.game) room.game.stop();
  room.game = null;
  if (!m || room.state !== 'playing') return;

  // Sonraki turun bilgisi ("Tur 2/5 · Avcı: Ayşe") tur sonu ekranında gösterilir
  let next = null;
  if (m.roundIndex + 1 < m.totalRounds) {
    const nextSeeker = seekerForRound(room, m.roundIndex + 1);
    const p = nextSeeker && room.players.get(nextSeeker);
    if (p) next = { round: m.roundIndex + 2, totalRounds: m.totalRounds, seekerName: p.name };
  }
  io.to(room.code).emit('round:end', { ...result, next, seconds: CONFIG.ROUND_END_SCREEN_MS / 1000 });
  m.roundIndex++;
  clearTimeout(m.timer);
  m.timer = setTimeout(() => startRound(room), CONFIG.ROUND_END_SCREEN_MS);
}

function finishMatch(room) {
  const m = room.match;
  if (!m) return;
  m.inFinal = true;
  m.returned = new Set();
  for (const p of room.players.values()) p.ready = false;
  const sorted = [...room.players.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      stats: { ...emptyStats(), ...(p.stats || {}) },
    }))
    .sort((a, b) => b.score - a.score);
  // Puanı eşit olan oyuncular aynı sırayı paylaşır
  let prevRank = 1;
  const standings = sorted.map((p, i) => {
    const rank = i > 0 && p.score === sorted[i - 1].score ? prevRank : i + 1;
    prevRank = rank;
    return { ...p, rank };
  });
  io.to(room.code).emit('match:end', { players: standings, seconds: CONFIG.FINAL_SCREEN_MS / 1000 });
  clearTimeout(m.timer);
  m.timer = setTimeout(() => endGame(room), CONFIG.FINAL_SCREEN_MS);
}

// Oyun bitince herkes aynı lobiye döner, hazırlık durumları sıfırlanır.
function endGame(room, reason) {
  if (room.game) room.game.stop();
  room.game = null;
  if (room.match) clearTimeout(room.match.timer);
  room.match = null;
  room.state = 'lobby';
  for (const p of room.players.values()) p.ready = false;
  broadcastRoom(room);
  io.to(room.code).emit('game:ended', { ...roomSnapshot(room), reason: reason || null });
}

function joinRoom(socket, room, nickRaw, preferredColorRaw = null) {
  const nick = sanitizeNick(nickRaw);
  const name = uniqueName(room, nick);
  const chosenColor = pickFreeArrowColor(room, preferredColorRaw);
  room.players.set(socket.id, {
    id: socket.id,
    name,
    ready: false,
    score: 0,
    color: chosenColor.id,
    colorHex: chosenColor.hex,
    stats: emptyStats(),
  });
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.name = name;
  socket.emit('room:joined', { ...roomSnapshot(room), you: socket.id, yourName: name, yourColor: chosenColor.id });
  broadcastRoom(room);
}

function handleSelectColor(socket, payload, ack) {
  const room = getPlayerRoom(socket);
  if (!room || room.state !== 'lobby') {
    return ack && ack({ ok: false, error: 'Renk sadece lobide seçilebilir' });
  }
  const me = room.players.get(socket.id);
  if (!me) return ack && ack({ ok: false, error: 'Oyuncu bulunamadı' });
  const raw = typeof payload === 'string'
    ? payload
    : (payload && (payload.color || payload.colorId || payload.arrowColor));
  const entry = resolveArrowColor(raw);
  if (!entry) return ack && ack({ ok: false, error: 'Geçersiz renk' });
  for (const [pid, p] of room.players) {
    if (pid !== socket.id && p.color === entry.id) {
      return ack && ack({ ok: false, error: 'Bu renk başka bir oyuncuda' });
    }
  }
  me.color = entry.id;
  me.colorHex = entry.hex;
  broadcastRoom(room);
  return ack && ack({ ok: true, color: me.color, colorHex: me.colorHex });
}

// ---------- SOCKET ----------
io.on('connection', (socket) => {
  socket.on('room:create', ({ nick, color } = {}, ack) => {
    const clean = sanitizeNick(nick);
    if (!clean) return ack && ack({ ok: false, error: 'Takma ad boş olamaz' });
    if (getPlayerRoom(socket)) removePlayer(socket);

    const code = generateRoomCode();
    const room = { code, leaderId: socket.id, state: 'lobby', players: new Map(), game: null, match: null, settings: defaultSettings() };
    rooms.set(code, room);
    joinRoom(socket, room, clean, color);
    ack && ack({ ok: true, code });
  });

  socket.on('room:join', ({ nick, code, color } = {}, ack) => {
    const clean = sanitizeNick(nick);
    if (!clean) return ack && ack({ ok: false, error: 'Takma ad boş olamaz' });
    const upper = String(code || '').trim().toUpperCase();
    const room = rooms.get(upper);
    if (!room) return ack && ack({ ok: false, error: 'Bu kodla bir oda yok' });
    if (room.state !== 'lobby') {
      return ack && ack({ ok: false, error: 'Oyun başlamış, bitmesini bekle' });
    }
    if (room.players.size >= CONFIG.MAX_PLAYERS) {
      return ack && ack({ ok: false, error: `Oda dolu (en fazla ${CONFIG.MAX_PLAYERS} kişi)` });
    }
    if (getPlayerRoom(socket)) removePlayer(socket);

    joinRoom(socket, room, clean, color);
    ack && ack({ ok: true, code: room.code });
  });

  socket.on('player:color', (payload, ack) => handleSelectColor(socket, payload, ack));
  socket.on('player:selectColor', (payload, ack) => handleSelectColor(socket, payload, ack));

  socket.on('room:leave', () => {
    removePlayer(socket);
    socket.emit('room:left', { reason: 'left' });
  });

  socket.on('player:toggleReady', () => {
    const room = getPlayerRoom(socket);
    if (!room || room.state !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !p.ready;
    broadcastRoom(room);
    maybeStartGame(room);
  });

  // Lider oyun ayarlarını değiştirir: { rounds?, roundMinutes?, npcDensity? }
  // Değişince herkesin hazırlık durumu sıfırlanır ve herkes yeni ayarı anında görür.
  socket.on('room:settings', (payload = {}) => {
    const room = getPlayerRoom(socket);
    if (!room || room.state !== 'lobby' || room.leaderId !== socket.id) return;
    if (!payload || typeof payload !== 'object') return;
    const next = { ...room.settings };
    if (payload.rounds !== undefined) {
      const r = Number(payload.rounds);
      if (!Number.isInteger(r) || r < CONFIG.ROUNDS_MIN || r > CONFIG.ROUNDS_MAX) return;
      next.rounds = r;
    }
    if (payload.roundMinutes !== undefined) {
      const m = Number(payload.roundMinutes);
      if (!CONFIG.ROUND_MINUTES_OPTIONS.includes(m)) return;
      next.roundMinutes = m;
    }
    if (payload.npcDensity !== undefined) {
      if (!CONFIG.NPC_DENSITY_ORDER.includes(payload.npcDensity)) return;
      next.npcDensity = payload.npcDensity;
    }
    if (next.rounds === room.settings.rounds && next.roundMinutes === room.settings.roundMinutes &&
        next.npcDensity === room.settings.npcDensity) return;
    room.settings = next;
    for (const p of room.players.values()) p.ready = false;
    broadcastRoom(room);
  });

  socket.on('player:kick', ({ targetId } = {}) => {
    const room = getPlayerRoom(socket);
    if (!room || room.leaderId !== socket.id) return;
    if (!targetId || targetId === socket.id) return;
    const target = io.sockets.sockets.get(targetId);
    if (!target || !room.players.has(targetId)) return;
    removePlayer(target);
    target.emit('room:left', { reason: 'kicked' });
  });

  // ---------- OYUN ----------
  // Saklanan: E tuşu (elmas al / heykeli incele / VIP'yi öldür)
  socket.on('game:interact', () => {
    const room = getPlayerRoom(socket);
    if (room && room.game) room.game.handleInteract(socket.id);
  });

  // Performans göstergesi (F3): ping ölçümü
  socket.on('game:ping', (t0, ack) => {
    if (typeof ack === 'function') ack(t0);
  });

  // Saklanan: sadece tuş durumu gönderir { u, d, l, r }
  socket.on('game:input', (input) => {
    const room = getPlayerRoom(socket);
    if (room && room.game) room.game.handleInput(socket.id, input);
  });

  // Avcı: dünya koordinatında tıklanan nokta { x, y }
  socket.on('game:shoot', ({ x, y } = {}) => {
    const room = getPlayerRoom(socket);
    if (room && room.game) room.game.handleShoot(socket.id, x, y);
  });

  // Avcı: çatı altında görüş alanı açmak için fare konumu { x, y } | null
  socket.on('game:mouse', (pos) => {
    const room = getPlayerRoom(socket);
    if (room && room.game) room.game.handleSeekerMouse(socket.id, pos);
  });

  // Yetenek seçimi (tur başı 10 sn)
  socket.on('game:pickSkill', ({ skillId } = {}) => {
    const room = getPlayerRoom(socket);
    if (room && room.game) room.game.handlePickSkill(socket.id, skillId);
  });

  // Yetenek kullanımı (Q/R tuşu veya buton)
  socket.on('game:useSkill', (payload) => {
    const room = getPlayerRoom(socket);
    if (room && room.game) room.game.handleUseSkill(socket.id, payload);
  });

  // Liderlik tablosunda "Lobiye dön" butonu: herkes basınca veya 15 sn dolunca lobiye dönülür
  socket.on('match:returnLobby', () => {
    const room = getPlayerRoom(socket);
    if (!room || !room.match || !room.match.inFinal) return;
    room.match.returned.add(socket.id);
    const allReturned = [...room.players.keys()].every((id) => room.match.returned.has(id));
    if (allReturned) {
      endGame(room);
    } else {
      socket.emit('room:update', roomSnapshot(room));
    }
  });

  socket.on('disconnect', () => {
    removePlayer(socket);
  });
});

server.listen(CONFIG.PORT, () => {
  console.log(`Act Like NPC sunucusu çalışıyor: http://localhost:${CONFIG.PORT}`);
});
