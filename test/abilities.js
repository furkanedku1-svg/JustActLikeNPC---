// ============================================================
//  Otomatik yetenek, kapalı alan peek, elmas ve NPC testleri
//  Kullanım: npm run test:abilities
// ============================================================
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const { MAPS } = require('../game/maps');
const { Game } = require('../game/Game');

const PROJECT = path.join(__dirname, '..');
const PORT = 3458;
const URL = `http://localhost:${PORT}`;
const map = MAPS.square;

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const underRoof = (x, y) => map.roofs.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);

const once = (s, ev, ms = 12000, cond = () => true) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`zaman aşımı: ${ev}`)); }, ms);
  const h = (d) => { if (!cond(d)) return; clearTimeout(t); s.off(ev, h); res(d); };
  s.on(ev, h);
});
const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));

function mk(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.nick = name;
  s.init = null;
  s.state = null;
  s.diamonds = [];
  s.notes = [];
  s.looks = [];
  s.stateLooks = [];
  s.sfx = [];
  s.picked = [];
  s.skillState = null;
  s.puffs = [];
  s.tasks = null;
  s.room = null;
  s.hiderArrows = [];
  s.hiderArrowsEvents = 0;
  s.on('room:joined', (r) => { s.room = r; });
  s.on('room:update', (r) => { s.room = r; });
  s.on('game:init', (d) => {
    s.init = d;
    s.state = null;
    s.stateLooks = [];
    s.picked = [];
    s.skillState = null;
    s.puffs = [];
    s.tasks = d.tasks || null;
    s.hiderArrows = d.hiderArrows || [];
    s.hiderArrowsEvents = 0;
  });
  s.on('game:hiderArrows', (list) => { s.hiderArrows = list; s.hiderArrowsEvents++; });
  s.on('game:state', (d) => { s.state = d; if (d.looks) s.stateLooks.push(...d.looks); });
  s.on('game:diamonds', (d) => { s.diamonds = d; });
  s.on('game:notify', (d) => s.notes.push(d));
  s.on('game:look', (d) => s.looks.push(d));
  s.on('game:sfx', (d) => s.sfx.push(d.name));
  s.on('game:skillPicked', (d) => s.picked.push(d));
  s.skillStates = [];
  s.on('game:skillState', (d) => { s.skillState = d; s.skillStates.push({ t: Date.now(), d }); });
  s.on('game:puffs', (list) => { s.puffs.push(...list); });
  s.on('game:tasks', (d) => { s.tasks = d; });
  return s;
}

const posOf = (s, id) => {
  const e = s.state && s.state.c.find((x) => x[0] === id);
  return e ? { x: e[1], y: e[2], dead: !!(e[4] & 2) } : null;
};

async function walkTo(s, target, within, timeout) {
  const t0 = Date.now();
  let lastPos = null, lastMove = Date.now(), detour = 0, detourUntil = 0;
  while (Date.now() - t0 < timeout) {
    const me = posOf(s, s.init.youCharId);
    if (!me) { await sleep(80); continue; }
    const dx = target.x - me.x, dy = target.y - me.y;
    if (Math.hypot(dx, dy) <= within) { s.emit('game:input', {}); await sleep(150); return true; }
    if (lastPos && Math.hypot(me.x - lastPos.x, me.y - lastPos.y) > 2) lastMove = Date.now();
    if (Date.now() - lastMove > 1100) {
      detour = (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2;
      detourUntil = Date.now() + 900;
      lastMove = Date.now();
    }
    const ang = Math.atan2(dy, dx) + (Date.now() < detourUntil ? detour : 0);
    s.emit('game:input', { r: Math.cos(ang) > 0.38, l: Math.cos(ang) < -0.38, d: Math.sin(ang) > 0.38, u: Math.sin(ang) < -0.38 });
    lastPos = me;
    await sleep(90);
  }
  s.emit('game:input', {});
  return false;
}

async function pickNearestDiamond(s, timeout = 30000) {
  const before = (s.tasks && s.tasks.diamonds) || 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const me = posOf(s, s.init.youCharId);
    const list = s.diamonds
      .filter((d) => !underRoof(d[1], d[2]))
      .sort((a, b) => Math.hypot(a[1] - me.x, a[2] - me.y) - Math.hypot(b[1] - me.x, b[2] - me.y));
    const target = list[0];
    if (!target) return false;
    if (!(await walkTo(s, { x: target[1], y: target[2] }, 20, timeout))) continue;
    s.emit('game:interact');
    try {
      await once(s, 'game:tasks', 2600, (t) => t.diamonds > before);
      await sleep(120);
      return true;
    } catch (_) {
      // Yakında NPC ittiyse veya geciktiyse bir kez daha dene
    }
  }
  return false;
}

const UNIT_CONFIG = require('./unitConfig');
// Test turu 110 sn: avcı yeteneği min(90, 110/2) = 55 sn kala açılır
const TEST_ROUND_TIME = 110;
const TEST_CULL_LEFT = Math.min(90, TEST_ROUND_TIME / 2);

(async () => {
  const server = spawn(process.execPath, [path.join(PROJECT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      ROUND_TIME: String(TEST_ROUND_TIME),
      ROUND_END_MS: '800',
      FINAL_MS: '800',
      SKILL_PICK_TIME: '2',
      CULL_UNLOCK_LEFT: '90',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });
  await new Promise((res) => server.stdout.once('data', res));

  try {
    const A = mk('Ali'), B = mk('Buse'), C = mk('Can');
    const all = [A, B, C];
    await Promise.all(all.map((s) => once(s, 'connect')));
    const { code } = await emit(A, 'room:create', { nick: 'Ali' });
    await emit(B, 'room:join', { nick: 'Buse', code });
    await emit(C, 'room:join', { nick: 'Can', code, color: 'red' }); // 'red' Ali'de dolu -> Can otomatik boştaki ilk rengi ('yellow') alır
    await sleep(100);

    // ---------- LOBİ OK RENGİ SEÇİMİ TESTİ ----------
    const colors0 = A.room.players.map((p) => p.color);
    ok(colors0.join(',') === 'red,orange,yellow', `Odaya yeni girenlere otomatik boştaki ilk renkler verildi (${colors0.join(',')})`);
    ok(Array.isArray(A.room.arrowColors) && A.room.arrowColors.length === 10, 'Lobide 10 ok rengi seçeneği var');

    // Başkasının rengini seçme denemesi sunucuda reddedilir
    const takeOccupied = await emit(B, 'player:color', { color: 'red' });
    ok(!takeOccupied.ok, 'Başkasının seçtiği renk seçilemez');

    // İki oyuncu aynı anda aynı boş rengi seçerse sadece ilk seçen alır
    const [raceB, raceC] = await Promise.all([
      emit(B, 'player:color', { color: 'purple' }),
      emit(C, 'player:color', { color: 'purple' }),
    ]);
    ok((raceB.ok ? 1 : 0) + (raceC.ok ? 1 : 0) === 1, 'Aynı anda aynı rengi seçen iki kişiden sadece ilki aldı');
    const takeFree = await emit(C, 'player:color', { color: 'cyan' });
    ok(takeFree.ok && takeFree.color === 'cyan', 'Boştaki renk başarıyla seçildi');
    await sleep(80);
    const lobbyColorByNick = Object.fromEntries(A.room.players.map((p) => [p.name, p.colorHex]));

    // ---------- TUR 1: Tek Avcı yeteneği (Kalabalığı Azalt) + Çatı Peek + Kilit/Açılış ----------
    all.forEach((s) => s.emit('player:toggleReady'));
    await Promise.all(all.map((s) => once(s, 'game:init')));
    await sleep(300);

    let seeker = all.find((s) => s.init.role === 'seeker');
    let hiders = all.filter((s) => s.init.role === 'hider');
    ok(seeker.init.hiderArrows === undefined && seeker.hiderArrowsEvents === 0, 'Avcıya ok renkleri veya kim oyuncu bilgisi hiç gönderilmez');
    ok(
      hiders.every((h) => Array.isArray(h.init.hiderArrows)
        && h.init.hiderArrows.length === 2
        && h.init.hiderArrows.every((a) => a.length === 2 && typeof a[0] === 'number' && typeof a[1] === 'string')
        && hiders.every((oh) => h.init.hiderArrows.some(([cid, hex]) => cid === oh.init.youCharId && hex === lobbyColorByNick[oh.nick]))),
      'Her saklanan hem kendi okunu hem diğer saklananların okunu kendi renklerinde görür (isim bilgisi yok)',
    );
    ok(
      seeker.init.phase === 'pick'
      && seeker.init.assignedSkill && seeker.init.assignedSkill.skillId === 'cull'
      && seeker.init.skillOptions.map((o) => o.id).join(',') === 'cull,radar',
      'Avcı seçim yapmaz; Kalabalığı Azalt (Q) ve Radar Bombası (R) her zaman avcıdadır',
    );
    ok(
      hiders.every((h) => h.init.skillOptions.map((o) => o.id).join(',') === 'disguise,smoke'),
      'Saklananlar Kıyafet Değiştirme ve Sis Bombası seçeneklerini görür',
    );
    ok(
      hiders[0].init.myDiamondIds === undefined && hiders[0].diamonds.length === 12,
      `Kişiye özel elmas yok; toplam 3×2+6=12 paylaşımlı elmas (${hiders[0].diamonds.length})`,
    );
    ok(
      !!hiders[0].init.map.fountain && !hiders[0].init.map.statue
      && Array.isArray(hiders[0].init.map.statues) && hiders[0].init.map.statues.length === 6
      && hiders[0].init.map.statues.every((st) => !underRoof(st.x, st.y)),
      'Ortada fıskiye ve tamamı açık alanda 6 küçük sabit heykel var',
    );

    // Seçim sırasında oyuncular hareket edemez, NPC'ler yürür
    const pBefore = posOf(hiders[0], hiders[0].init.youCharId);
    const snapBefore = hiders[0].state.c.map((e) => [e[0], e[1], e[2]]);
    hiders[0].emit('game:input', { r: true });
    await sleep(600);
    hiders[0].emit('game:input', {});
    const pAfter = posOf(hiders[0], hiders[0].init.youCharId);
    const npcMoved = snapBefore.some(([id, x, y]) => {
      if (id === hiders[0].init.youCharId || id === hiders[1].init.youCharId) return false;
      const cur = posOf(hiders[0], id);
      return cur && Math.hypot(cur.x - x, cur.y - y) > 5;
    });
    ok(Math.hypot(pAfter.x - pBefore.x, pAfter.y - pBefore.y) < 1, 'Yetenek seçimi sırasında oyuncu hareket edemez');
    ok(npcMoved, 'Yetenek seçimi sırasında NPC\'ler arka planda dolaşmaya devam eder');

    // Avcının game:pickSkill denemesi yoksayılır; sadece 1 saklanan seçer, diğerine otomatik verilir
    seeker.emit('game:pickSkill', { skillId: 'disguise' });
    hiders[0].emit('game:pickSkill', { skillId: 'disguise' });
    await once(hiders[0], 'game:skillPicked', 2500);
    ok(seeker.picked.length === 0 && hiders[1].picked.length === 0, 'Seçimler kimseye sızdırılmaz ve avcı pickSkill kullanamaz');
    await Promise.all(all.map((s) => once(s, 'game:playStart', 4500)));
    ok(hiders[1].picked.length === 1 && ['disguise', 'smoke'].includes(hiders[1].picked[0].skillId), 'Süre dolunca seçmeyen saklanana rastgele yetenek verildi');

    // Kalabalığı Azalt: min(1:30, tur süresinin yarısı) kala açılır
    ok(seeker.init.skillsCfg.cullUnlockLeft === TEST_CULL_LEFT, `Avcı yeteneği ${TEST_ROUND_TIME} sn'lik turda ${TEST_CULL_LEFT} sn kala açılacak (min(90, süre/2))`);
    const playStartedAt = Date.now();
    const cullNoteUnlockPromise = once(hiders[0], 'game:notify', (TEST_ROUND_TIME - TEST_CULL_LEFT + 15) * 1000, (n) => n.text.includes('Avcının yeteneği açıldı'));
    seeker.emit('game:useSkill');
    await sleep(250);
    ok(!seeker.skillState && seeker.puffs.length === 0, 'Açılış süresinden önce Kalabalığı Azalt kilitli kalır');

    // Çatı peek testi: hiders[0] en yakın çatı altına girer
    const H_ROOF = hiders[0];
    const H_OTHER = hiders[1];
    const r0 = posOf(H_ROOF, H_ROOF.init.youCharId);
    const nearRoof = [...map.roofs].sort(
      (a, b) => Math.hypot(a.x + a.w / 2 - r0.x, a.y + a.h / 2 - r0.y) - Math.hypot(b.x + b.w / 2 - r0.x, b.y + b.h / 2 - r0.y),
    )[0];
    ok(await walkTo(H_ROOF, { x: nearRoof.x + 35, y: nearRoof.y + nearRoof.h / 2 }, 25, 35000), 'Saklanan çatı altına girdi');
    await sleep(200);

    const pingAck = await new Promise((r) => seeker.emit('game:ping', (ack) => r(ack)));
    ok(pingAck === true, 'F3 performans göstergesi için game:ping sunucu yanıtı çalışıyor');

    seeker.emit('game:mouse', null);
    await sleep(150);
    ok(!posOf(seeker, H_ROOF.init.youCharId), 'Fare olmadan çatı altındaki karakter avcıya gönderilmez');

    const roofDiamonds = H_ROOF.diamonds.filter((d) => underRoof(d[1], d[2]));
    ok(
      roofDiamonds.length >= 3 && seeker.diamonds.length === H_ROOF.diamonds.length
      && roofDiamonds.every((rd) => seeker.diamonds.some((sd) => sd[0] === rd[0])),
      `Avcı kapalı alanlardaki elmasları (${roofDiamonds.length}/12) nişangâh olmadan da her zaman görür`,
    );

    // Açık alana fare götür -> çatı altı yine gönderilmez
    seeker.emit('game:mouse', { x: 700, y: 200 });
    await sleep(150);
    ok(!posOf(seeker, H_ROOF.init.youCharId), 'Açık alandaki fare çatı altını açmaz');

    // Çatı üstünde ama > 140 birim uzağa fare götür -> gönderilmez
    const hrPos = posOf(H_ROOF, H_ROOF.init.youCharId);
    const veryFarX = Math.min(nearRoof.x + nearRoof.w - 10, hrPos.x + 175);
    seeker.emit('game:mouse', { x: veryFarX, y: hrPos.y });
    await sleep(150);
    ok(!posOf(seeker, H_ROOF.init.youCharId), '140 birim dışındaki çatı altı karakter avcıya gönderilmez');

    // Çatı üstünde 80-140 birim arası (110 br): anlık nişangâh takibi için avcıya gönderilir, ama 80 br dışında olduğu için vurulamaz!
    const preloadX = hrPos.x + 110;
    seeker.emit('game:mouse', { x: preloadX, y: hrPos.y });
    await sleep(160);
    ok(!!posOf(seeker, H_ROOF.init.youCharId), 'Nişangâhın 140 birim yakınındaki çatı altı karakter ön-yükleme için avcıya gönderilir');
    seeker.emit('game:shoot', { x: hrPos.x, y: hrPos.y });
    await sleep(150);
    ok((posOf(H_ROOF, H_ROOF.init.youCharId)[4] & 2) === 0, 'Sunucu atış kontrolünü 80 birime göre yapar (110 birimdeyken çatı altı karakter vurulamaz)');

    // Tam karakter üstüne fare götür -> 80 birim içinde görünür olur!
    seeker.emit('game:mouse', { x: hrPos.x, y: hrPos.y });
    await sleep(180);
    ok(!!posOf(seeker, H_ROOF.init.youCharId), 'Çatı üstündeki nişangâhın 80 birim içi avcıya gönderildi');

    seeker.emit('game:mouse', null);
    await sleep(150);

    // ---------- RADAR BOMBASI TESTİ (0,8 sn düşüş + 130 br oyuncu sayısı + 3 sn görünme + 15 sn dolum) ----------
    all.forEach((s) => { s.notes.length = 0; });
    const radarTarget = posOf(H_ROOF, H_ROOF.init.youCharId);
    const otherPos = posOf(H_OTHER, H_OTHER.init.youCharId);
    const expectedRadarCount = 1 + (otherPos && Math.hypot(otherPos.x - radarTarget.x, otherPos.y - radarTarget.y) <= 130 ? 1 : 0);
    const tRadarThrow = Date.now();
    seeker.emit('game:useSkill', { skillId: 'radar', x: radarTarget.x, y: radarTarget.y });
    const radarSkillSt = await once(seeker, 'game:skillState', 2000, (d) => d.skillId === 'radar');
    ok(
      radarSkillSt.usesLeft === null && radarSkillSt.cooldownTotalMs === 15000 && radarSkillSt.cooldownMs > 14000,
      `Radar Bombası atılınca 15 sn bekleme başladı (${radarSkillSt.cooldownMs} ms)`,
    );
    await sleep(250);
    ok(
      seeker.state.rb && seeker.state.rb.length === 1 && seeker.state.rb[0][3] === 0 && seeker.state.rb[0][6] === null,
      'Radar Bombası ilk 0,8 sn havada düşüyor (henüz sayı yok)',
    );
    // Düşmesini bekle (~0,8 sn)
    await once(H_ROOF, 'game:notify', 2000, (n) => n.text === '📡 Radar!');
    await sleep(120);
    const sRb = seeker.state.rb && seeker.state.rb[0];
    const hRb = H_ROOF.state.rb && H_ROOF.state.rb[0];
    ok(
      !!sRb && sRb[3] === 1 && sRb[6] === expectedRadarCount,
      `Radar Bombası düşünce çatı altındaki saklananı da saydı ve avcıya "${sRb && sRb[6]}" gösterdi (beklenen: ${expectedRadarCount})`,
    );
    ok(
      !!hRb && hRb[3] === 1 && hRb.length === 6 && hRb[6] === undefined,
      'Saklananlar bombanın düştüğünü ve alanı görür ama oyuncu sayısı saklananlara gönderilmez',
    );
    // Bekleme süresinde 2. radar atılamaz
    const radarStLen = seeker.skillStates.length;
    seeker.emit('game:useSkill', { skillId: 'radar', x: 700, y: 400 });
    await sleep(200);
    ok(seeker.skillStates.length === radarStLen, '15 sn dolmadan 2. Radar Bombası atılamaz');

    // 3 sn sonra radar bombası haritadan kalkar
    const waitExpire = Math.max(0, 3950 - (Date.now() - tRadarThrow));
    if (waitExpire > 0) await sleep(waitExpire);
    ok(!seeker.state.rb || seeker.state.rb.length === 0, '3 sn sonunda Radar Bombası ekrandan kalktı');

    // 15 sn dolunca Radar Bombası yeniden kullanılabilir (oyuncu olmayan köşeye at -> "0")
    const waitRadarCd = Math.max(0, 15150 - (Date.now() - tRadarThrow));
    if (waitRadarCd > 0) await sleep(waitRadarCd);
    const h0Now = posOf(H_ROOF, H_ROOF.init.youCharId);
    const h1Now = posOf(H_OTHER, H_OTHER.init.youCharId);
    const corners = [{ x: 80, y: 720 }, { x: 1320, y: 80 }, { x: 1320, y: 720 }, { x: 700, y: 80 }];
    const emptySpot = corners.find((pt) => (
      (!h0Now || Math.hypot(h0Now.x - pt.x, h0Now.y - pt.y) > 160)
      && (!h1Now || Math.hypot(h1Now.x - pt.x, h1Now.y - pt.y) > 160)
    )) || { x: 700, y: 80 };
    seeker.emit('game:useSkill', { skillId: 'radar', x: emptySpot.x, y: emptySpot.y });
    const radarSt2 = await once(seeker, 'game:skillState', 2000, (d) => d.skillId === 'radar').catch(() => null);
    await sleep(950);
    const sRb2 = seeker.state.rb && seeker.state.rb[0];
    ok(!!radarSt2 && !!sRb2 && sRb2[3] === 1 && sRb2[6] === 0, '15 sn sonra Radar Bombası yenilendi ve boş alanda "0" gösterdi');

    // Açılış bildirimi + Kalabalığı Azalt kullanımı
    await cullNoteUnlockPromise;
    const unlockAfter = (Date.now() - playStartedAt) / 1000;
    ok(Math.abs(unlockAfter - (TEST_ROUND_TIME - TEST_CULL_LEFT)) < 3, `Kalan süre ${TEST_CULL_LEFT} sn olunca herkese "Avcının yeteneği açıldı" bildirimi gitti (${unlockAfter.toFixed(1)} sn sonra)`);

    const countAliveNpcs = (viewer) => viewer.state.c.filter(
      (e) => e[0] !== hiders[0].init.youCharId && e[0] !== hiders[1].init.youCharId && !(e[4] & 2),
    ).length;
    const aliveNpcsBefore = countAliveNpcs(H_OTHER);
    const expectedCull = Math.floor(aliveNpcsBefore * 0.2);

    seeker.puffs.length = 0;
    all.forEach((s) => { s.notes.length = 0; });
    seeker.emit('game:mouse', null);
    await sleep(120);

    seeker.emit('game:useSkill');
    await sleep(300);
    const aliveNpcsAfter = countAliveNpcs(H_OTHER);
    const deadCountAfterCull = H_OTHER.state.c.filter((e) => e[4] & 2).length;
    ok(
      aliveNpcsAfter === aliveNpcsBefore - expectedCull && expectedCull > 0,
      `Kalabalığı Azalt tam %20 NPC sildi (${aliveNpcsBefore} -> ${aliveNpcsAfter}, silinen: ${expectedCull})`,
    );
    ok(deadCountAfterCull === 0, 'Silinen NPC\'ler ceset bırakmadı');
    ok(!!posOf(H_ROOF, H_ROOF.init.youCharId) && !!posOf(H_OTHER, H_OTHER.init.youCharId), 'Gerçek oyuncular asla silinmedi');
    ok(seeker.skillState && seeker.skillState.usesLeft === 0, 'Kalabalığı Azalt 1 kullanım hakkı bitti');
    ok(H_OTHER.notes.some((n) => n.text.includes('NPC\'lerin %20\'si gitti')), 'Herkese Kalabalığı Azalt bildirimi gitti');
    ok(seeker.puffs.every((p) => !underRoof(p.x, p.y)), `Avcının puf efektleri çatı altını sızdırmadı (${seeker.puffs.length} görünür puf)`);

    // 2. kez basınca çalışmaz
    all.forEach((s) => { s.notes.length = 0; });
    seeker.emit('game:useSkill');
    await sleep(200);
    ok(countAliveNpcs(H_OTHER) === aliveNpcsAfter && H_OTHER.notes.length === 0, 'Kalabalığı Azalt 2. kez kullanılamaz');

    // Çatı peek içinden ateş edebilme + kalan saklananı vurup Tur 1'i bitirme
    const round1End = once(A, 'round:end', 35000);
    let r1Done = false;
    round1End.then(() => { r1Done = true; }, () => {});

    const shootTarget = posOf(H_ROOF, H_ROOF.init.youCharId);
    seeker.emit('game:mouse', { x: shootTarget.x, y: shootTarget.y });
    await sleep(160);
    seeker.emit('game:shoot', { x: shootTarget.x, y: shootTarget.y });
    await sleep(200);
    const afterPeekShot = posOf(H_ROOF, H_ROOF.init.youCharId);
    ok(afterPeekShot && afterPeekShot.dead, 'Avcı 80 birimlik çatı penceresinin içinde gördüğü oyuncuyu vurabildi');
    ok(
      H_ROOF.hiderArrows.length === 1 && H_ROOF.hiderArrows[0][0] === H_OTHER.init.youCharId
      && H_OTHER.hiderArrows.length === 1 && H_OTHER.hiderArrows[0][0] === H_OTHER.init.youCharId
      && seeker.hiderArrowsEvents === 0,
      'Vurulan saklananın oku kayboldu; izleyici modundaki saklanan hayatta kalan diğer saklananın okunu görmeye devam ediyor ve avcıya sızıntı yok',
    );

    const curOther = posOf(H_OTHER, H_OTHER.init.youCharId);
    if (curOther && !curOther.dead) {
      const openPt = { x: curOther.x < 700 ? 480 : 920, y: curOther.y < 400 ? 200 : 600 };
      await walkTo(H_OTHER, openPt, 25, 25000);
      const t0 = Date.now();
      while (!r1Done && Date.now() - t0 < 15000) {
        const p = posOf(H_OTHER, H_OTHER.init.youCharId);
        if (!p || p.dead) break;
        if (!seeker.state || seeker.state.g === 0) seeker.emit('game:shoot', { x: p.x, y: p.y });
        await sleep(250);
      }
    }
    await round1End;

    // ---------- TUR 2: Paylaşımlı elmas (10 sn yenilenme), kıyafet, sis + çatı peek bloklama ----------
    await Promise.all(all.map((s) => once(s, 'game:init', 8000)));
    seeker = all.find((s) => s.init.role === 'seeker');
    hiders = all.filter((s) => s.init.role === 'hider');
    const H_DIS = hiders[0];
    const H_SMOKE = hiders[1];

    const play2 = Promise.all(all.map((s) => once(s, 'game:playStart', 4500)));
    H_DIS.emit('game:pickSkill', { skillId: 'disguise' });
    H_SMOKE.emit('game:pickSkill', { skillId: 'smoke' });
    await play2;
    await sleep(250);

    // 1) Paylaşımlı herhangi bir açık elması H_DIS toplar -> -1 olur, sonra ~10 sn içinde yenilenir
    const openDiamond = H_DIS.diamonds.find((d) => !underRoof(d[1], d[2]));
    ok(!!openDiamond, 'Açık alanda paylaşımlı elmas bulundu');
    let pickedDiamondAt = 0;
    if (openDiamond) {
      const gotDiamond = await pickNearestDiamond(H_DIS, 35000);
      pickedDiamondAt = Date.now();
      ok(gotDiamond && H_DIS.diamonds.length === 11 && H_DIS.tasks && H_DIS.tasks.diamonds === 1, `Elmas toplanınca sayı azaldı (${H_DIS.diamonds.length}) ve görev ilerledi`);
    }

    // 2) H_DIS çatı altında kıyafet değiştirme (2 hak + avcıya sızmaz)
    const dis0 = posOf(H_DIS, H_DIS.init.youCharId);
    const roofDis = [...map.roofs].sort(
      (a, b) => Math.hypot(a.x + a.w / 2 - dis0.x, a.y + a.h / 2 - dis0.y) - Math.hypot(b.x + b.w / 2 - dis0.x, b.y + b.h / 2 - dis0.y),
    )[0];
    ok(await walkTo(H_DIS, { x: roofDis.x + roofDis.w / 2, y: roofDis.y + roofDis.h / 2 }, 40, 35000), 'Kıyafetçimiz çatı altına yürüdü');
    await sleep(150);

    const oldLook = H_DIS.init.appearances.find((a) => a[0] === H_DIS.init.youCharId);
    seeker.looks.length = 0;
    H_DIS.emit('game:useSkill');
    const look1 = await once(H_DIS, 'game:look', 3000, (l) => l[0] === H_DIS.init.youCharId);
    ok(look1[1] !== oldLook[1] && look1[2] !== oldLook[2], 'Kıyafet değiştirme farklı kıyafet ve şapkaya geçti');
    ok(seeker.looks.every((l) => l[0] !== H_DIS.init.youCharId), 'Çatı altında kıyafet değiştirince avcıya sızıntı gitmedi');

    H_DIS.emit('game:useSkill');
    await once(H_DIS, 'game:look', 3000, (l) => l[0] === H_DIS.init.youCharId);
    await sleep(150);
    ok(H_DIS.skillState && H_DIS.skillState.usesLeft === 0, 'Kıyafet değiştirme turda 2 hak sonunda bitti');

    // 3) H_SMOKE çatı altına girip sis atar -> avcının 80 birimlik peek penceresi bile sis içini göremez!
    const sm0 = posOf(H_SMOKE, H_SMOKE.init.youCharId);
    const roofSmoke = [...map.roofs].sort(
      (a, b) => Math.hypot(a.x + a.w / 2 - sm0.x, a.y + a.h / 2 - sm0.y) - Math.hypot(b.x + b.w / 2 - sm0.x, b.y + b.h / 2 - sm0.y),
    )[0];
    ok(await walkTo(H_SMOKE, { x: roofSmoke.x + roofSmoke.w / 2, y: roofSmoke.y + roofSmoke.h / 2 }, 35, 35000), 'Sisçi çatı altına yürüdü');
    const smPos = posOf(H_SMOKE, H_SMOKE.init.youCharId);

    seeker.emit('game:mouse', { x: smPos.x, y: smPos.y });
    await sleep(180);
    ok(!!posOf(seeker, H_SMOKE.init.youCharId), 'Sis atmadan önce çatı penceresinden saklanan görünüyor');

    const smokeStates0 = H_SMOKE.skillStates.length;
    H_SMOKE.emit('game:useSkill');
    const tThrow = Date.now();
    const st1 = await once(H_SMOKE, 'game:skillState', 2000);
    ok(st1.usesLeft === null && st1.cooldownTotalMs === 15000 && st1.cooldownMs > 14500 && st1.cooldownMs <= 15000,
      `Sis atılınca 15 sn bekleme başladı, hak sınırı yok (cooldown ${st1.cooldownMs} ms)`);
    await sleep(250);
    ok(!posOf(seeker, H_SMOKE.init.youCharId), 'Sis bombası çatı altındaki 80 birimlik peek penceresini de engelledi');
    ok(!!posOf(H_DIS, H_SMOKE.init.youCharId), 'Saklananlar sis içindeki oyuncuyu görmeye devam ediyor');
    const smokeIdOf = (s) => (s.state.sm || []).map((x) => x[0]);
    const firstSmokeIds = smokeIdOf(H_DIS);
    const smokeTotal = H_DIS.state.sm && H_DIS.state.sm[0] && H_DIS.state.sm[0][4];
    ok(smokeTotal === 10000, `Sis süresi 10 sn (${smokeTotal} ms)`);

    // Bekleme sırasında tekrar atılamaz
    H_SMOKE.emit('game:useSkill');
    await sleep(250);
    ok(H_SMOKE.skillStates.length === smokeStates0 + 1 && smokeIdOf(H_DIS).length === 1, 'Bekleme sürerken sis tekrar atılamadı');

    const untilT = async (ms) => { const w = tThrow + ms - Date.now(); if (w > 0) await sleep(w); };
    await untilT(9400);
    ok(!posOf(seeker, H_SMOKE.init.youCharId), '9,4 sn: sis hâlâ duruyor (10 sn sürer)');
    await untilT(10500);
    ok(!!posOf(seeker, H_SMOKE.init.youCharId) && smokeIdOf(H_DIS).length === 0, '10 sn sonra sis kalktı, çatı penceresinden tekrar göründü');

    // Bekleme sis atıldığı anda başladı: 14 sn'de hâlâ dolu değil, 15 sn'de yeniden kullanılabilir
    await untilT(14000);
    H_SMOKE.emit('game:useSkill');
    await sleep(200);
    ok(smokeIdOf(H_DIS).length === 0 && H_SMOKE.skillStates.length === smokeStates0 + 1, '14 sn: sis bombası henüz dolmadı');
    await untilT(15150);
    H_SMOKE.emit('game:useSkill');
    const st2 = await once(H_SMOKE, 'game:skillState', 2000).catch(() => null);
    await sleep(200);
    const secondIds = smokeIdOf(H_DIS);
    ok(!!st2 && secondIds.length === 1 && !firstSmokeIds.includes(secondIds[0]) && !posOf(seeker, H_SMOKE.init.youCharId),
      `15 sn sonra sis bombası yeniden kullanıldı (${((Date.now() - tThrow) / 1000).toFixed(1)} sn)`);

    // Elmas 10 sn yenilenme kontrolü
    if (pickedDiamondAt) {
      const waitLeft = Math.max(0, 10500 - (Date.now() - pickedDiamondAt));
      if (waitLeft > 0) await sleep(waitLeft);
      ok(H_DIS.diamonds.length === 12, `Alınan elmas 10 sn sonra rastgele yenilendi (${H_DIS.diamonds.length}/12)`);
    }

    // ---------- BİRİM TESTLERİ: VIP yeniden atama + NPC oranları & dokunmama ----------
    const fakeEmit = { emit() {}, except() { return fakeEmit; } };
    const fakeIo = { to() { return fakeEmit; } };
    const fakeRoom = { code: 'T', players: new Map([['s0', { id: 's0', name: 'P0', score: 0 }], ['s1', { id: 's1', name: 'P1', score: 0 }]]) };
    const g = new Game({ io: fakeIo, room: fakeRoom, config: UNIT_CONFIG, seekerId: 's0', onEnd() {} });
    g.start();
    clearInterval(g.timer);
    g.beginPlayPhase();

    // NPC hedef seçimi dağılımı ve kıyafet/hayranlık davranışı
    let roofPlans = 0, disguisePlans = 0, admirePlans = 0, inspectPlans = 0, inspectPlansOk = 0, openPlans = 0;
    const isNearAdmirable = (pt) => (
      g.diamonds.some((d) => Math.hypot(d.x - pt.x, d.y - pt.y) <= 45)
      || map.statues.some((st) => Math.hypot(st.x - pt.x, st.y - pt.y) <= 45)
    );
    const isNextToStatue = (pt) => map.statues.some((st) => Math.hypot(st.x - pt.x, st.y - pt.y) <= st.r + UNIT_CONFIG.INTERACT_RANGE);
    const sampleNpc = g.chars.find((c) => !c.ownerId);
    const N = 2000;
    for (let i = 0; i < N; i++) {
      g.chooseNpcTarget(sampleNpc);
      if (sampleNpc.ai.actionKind === 'inspect') {
        inspectPlans++;
        if (sampleNpc.ai.actionDur === UNIT_CONFIG.STATUE_INSPECT_TIME && isNextToStatue(sampleNpc.ai.target)) inspectPlansOk++;
      } else if (underRoof(sampleNpc.ai.target.x, sampleNpc.ai.target.y)) {
        roofPlans++;
        if (sampleNpc.ai.actionKind === 'disguise' && sampleNpc.ai.actionDur === 1.2) disguisePlans++;
      } else if (sampleNpc.ai.actionDur >= 1 && sampleNpc.ai.actionDur <= 3 && isNearAdmirable(sampleNpc.ai.target)) {
        admirePlans++;
      } else {
        openPlans++;
      }
    }
    const pct = (n) => ((n / N) * 100).toFixed(1);
    ok(roofPlans >= N * 0.19 && roofPlans <= N * 0.30 && disguisePlans > 0, `NPC çatı/kıyafet hedefi ~%24 (%${pct(roofPlans)}, kıyafet: ${disguisePlans})`);
    ok(admirePlans >= N * 0.06 && admirePlans <= N * 0.16, `NPC elmas/heykel hayranlık hedefi ~%10 (%${pct(admirePlans)})`);
    ok(inspectPlans >= N * 0.11 && inspectPlans <= N * 0.19, `NPC heykel inceleme hedefi ~%15 (%${pct(inspectPlans)})`);
    ok(inspectPlansOk === inspectPlans, `NPC incelemeleri bir heykelin yanında ve 3 sn (${inspectPlansOk}/${inspectPlans})`);
    ok(openPlans >= N * 0.44 && openPlans <= N * 0.58, `NPC açık alan hedefi ~%51 (%${pct(openPlans)})`);

    // 2400 tick (120 sn): halka SADECE heykel incelemesi / çatı altı kıyafet değiştirmede görünür;
    // NPC'ler elmasa dokunmaz, heykeli değiştirmez; bir heykeli en fazla 3 karakter inceler
    const diamondsSnap = JSON.stringify(g.diamonds);
    const statuesSnap = JSON.stringify(g.statueStates);
    let npcDisguiseExecutions = 0;
    const origChange = g.changeLook.bind(g);
    g.changeLook = (c, now) => { if (!c.ownerId) npcDisguiseExecutions++; return origChange(c, now); };
    let statueEmits = 0;
    g.io = { to() { return { emit(ev) { if (ev === 'game:statue') statueEmits++; }, except() { return this; } }; } };
    const inspectingIds = new Set();
    let inspectRingSeen = false, inspectRingFull = false;
    let ringTotal = 0, ringStatue = 0, ringRoof = 0, ringBad = 0, maxInspectors = 0, maxReserved = 0;
    let inspectStarts = 0, inspectStartsFacing = 0, waitsWithoutRing = 0;
    const prevState = new Map();
    const edge = (c, sid) => { const s = map.statues.find((x) => x.id === sid); return Math.hypot(c.x - s.x, c.y - s.y) - s.r; };
    for (let i = 0; i < 2400; i++) {
      g.lastTick = Date.now() - 50; g.tick();
      for (const c of g.chars) {
        if (c.ownerId || c.dead || !c.ai) continue;
        const se = g.serializeChar(c);
        const prog = se.length >= 6 ? se[5] / 100 : -1; // ağda 0..100 yüzde, halka yoksa eleman yok
        const ai = c.ai;
        const wasAction = prevState.get(c.id) === 'action';
        prevState.set(c.id, ai.state);
        if (ai.state === 'action' && ai.actionKind === 'wait' && prog < 0) waitsWithoutRing++;
        if (ai.state === 'action' && ai.actionKind === 'inspect') {
          inspectingIds.add(c.id);
          if (prog >= 0 && prog < 1) inspectRingSeen = true;
          if (prog >= 0.95) inspectRingFull = true;
          if (!wasAction) {
            inspectStarts++;
            const s = map.statues.find((x) => x.id === ai.inspectStatueId);
            const want = Math.atan2(s.y - c.y, s.x - c.x);
            let d = Math.abs(want - c.angle); if (d > Math.PI) d = Math.PI * 2 - d;
            if (d < 0.35) inspectStartsFacing++;
          }
        }
        if (prog < 0) continue;
        ringTotal++;
        if (ai.actionKind === 'inspect' && ai.state === 'action' && edge(c, ai.inspectStatueId) <= 25) ringStatue++;
        else if (ai.actionKind === 'disguise' && ai.state === 'action' && underRoof(c.x, c.y)) ringRoof++;
        else ringBad++;
      }
      for (const s of map.statues) {
        maxInspectors = Math.max(maxInspectors, g.inspectorsOf(s.id, true).size);
        maxReserved = Math.max(maxReserved, g.inspectorsOf(s.id, false).size);
      }
    }
    g.io = fakeIo;
    ok(JSON.stringify(g.diamonds) === diamondsSnap, 'NPC\'ler hiçbir elması toplamadı/değiştirmedi');
    ok(inspectingIds.size > 0, `NPC'ler heykel inceledi (${inspectingIds.size} farklı NPC)`);
    ok(inspectRingSeen && inspectRingFull, 'NPC incelemesinde ilerleme halkası 0→1 doldu (oyuncununkiyle aynı alan)');
    ok(ringBad === 0 && ringTotal === ringStatue + ringRoof, `Halka sadece heykel incelemesi (${ringStatue}) ve çatı altı kıyafet değiştirmede (${ringRoof}); hatalı: ${ringBad}`);
    ok(waitsWithoutRing > 0, `Elmas/rastgele noktada bekleyen NPC'lerde halka yok (${waitsWithoutRing} halkasız bekleme karesi)`);
    ok(inspectStarts > 0 && inspectStartsFacing === inspectStarts, `İnceleme başlarken NPC yüzünü heykele dönmüş (${inspectStartsFacing}/${inspectStarts})`);
    ok(maxInspectors <= 3 && maxReserved <= 3, `Bir heykeli aynı anda en fazla 3 karakter inceledi (en çok: ${maxInspectors}, yer ayırtan dahil: ${maxReserved})`);
    ok(JSON.stringify(g.statueStates) === statuesSnap && statueEmits === 0, 'NPC incelemeleri heykelleri değiştirmedi (game:statue gönderilmedi)');
    ok(npcDisguiseExecutions > 0, `NPC'ler çatı altında kıyafet değiştirdi (${npcDisguiseExecutions})`);

    // Heykele varamayan NPC incelemeyi başlatmaz: hedefe vardığında heykel kenarından >25 ise vazgeçer
    {
      const n = g.chars.find((c) => !c.ownerId && !c.dead);
      const s = map.statues[0];
      n.ai.actionKind = 'inspect';
      n.ai.inspectStatueId = s.id;
      n.ai.faceAngle = 0;
      n.ai.actionDur = 3;
      n.x = s.x + s.r + 40; n.y = s.y; // kenara 40 birim
      g.arriveNpc(n);
      ok(n.ai.state === 'idle' && n.ai.inspectStatueId === null && g.serializeChar(n).length < 6, 'Heykelin yanına varamayan NPC incelemeyi başlatmadı, halka yok');
    }

    // Aynı heykelde 3 inceleyen varken 4. NPC orayı seçmez
    {
      const s = map.statues[0];
      const npcs = g.chars.filter((c) => !c.ownerId && !c.dead).slice(0, 4);
      for (const c of g.chars) if (c.ai && c.ai.inspectStatueId === s.id) c.ai.inspectStatueId = null;
      npcs.slice(0, 3).forEach((c) => { c.ai.inspectStatueId = s.id; c.ai.state = 'action'; c.ai.actionKind = 'inspect'; });
      let chose = 0;
      for (let i = 0; i < 300; i++) { const p = g.pickInspectPoint(npcs[3]); if (p && p.statueId === s.id) chose++; }
      ok(chose === 0, `3 inceleyen varken 4. NPC aynı heykeli seçmedi (${chose}/300)`);
    }

    // Kalabalığı Azalt açılış süresi: min(1:30, tur süresinin yarısı)
    {
      const mk2 = (rt) => new Game({ io: fakeIo, room: fakeRoom, config: UNIT_CONFIG, seekerId: 's0', roundTime: rt, onEnd() {} });
      ok(mk2(180).cullUnlockLeft === 90 && mk2(60).cullUnlockLeft === 30 && mk2(120).cullUnlockLeft === 60 && mk2(300).cullUnlockLeft === 90,
        'Avcı yeteneği: 3 dk→1:30, 1 dk→0:30, 2 dk→1:00, 5 dk→1:30 kala açılır');
    }

    // ---------- VIP 3 vuruşta ölür ----------
    {
      const events = [];
      const recIo = { to(room) { const api = { emit(ev, d) { events.push({ room, ev, d }); }, except() { return api; } }; return api; } };
      const gv = new Game({ io: recIo, room: fakeRoom, config: UNIT_CONFIG, seekerId: 's0', onEnd() {} });
      fakeRoom.players.get('s1').score = 0;
      gv.start();
      clearInterval(gv.timer);
      gv.beginPlayPhase();
      const task = gv.tasks.get('s1');
      task.stage = 'vip'; task.statue = true; task.diamonds = 3;
      const me = gv.charById.get(gv.players.get('s1').charId);
      const vip = gv.charById.get(task.vipId);
      const placeNear = (d) => { me.x = vip.x + d; me.y = vip.y; };
      const vipAiBefore = vip.ai;
      placeNear(22);
      gv.handleInteract('s1');
      ok(task.vipHits === 1 && !vip.dead, '1. vuruş: VIP 1/3');
      ok(events.some((e) => e.ev === 'game:punch' && e.d.a === me.id && e.d.v === vip.id), 'Vuruşta yumruk/sarsılma animasyonu herkese gönderildi');
      gv.handleInteract('s1'); // 0,5 sn dolmadan
      ok(task.vipHits === 1, 'İki vuruş arası 0,5 sn beklemeden vuruş sayılmadı');
      task.lastHitAt -= 600;
      placeNear(45); // 30 birimden uzak
      gv.handleInteract('s1');
      ok(task.vipHits === 1, 'VIP 30 birimden uzaktayken vuruş olmadı');
      placeNear(28);
      gv.handleInteract('s1');
      ok(task.vipHits === 2 && !vip.dead && vip.ai === vipAiBefore && vip.ai.state !== 'flee', 'Uzaklaşıp geri gelince kaldığı yerden devam: 2/3, VIP kaçmadı');
      const tasksMsg = [...events].reverse().find((e) => e.ev === 'game:tasks' && e.room === 's1');
      ok(tasksMsg && tasksMsg.d.vipHits === 2 && tasksMsg.d.vipHitsNeeded === 3, 'Görev listesine "VIP 2/3" bilgisi gitti');
      task.lastHitAt -= 600;
      const scoreBefore = fakeRoom.players.get('s1').score;
      gv.handleInteract('s1');
      ok(vip.dead && task.vip && task.stage === 'done', '3. vuruşta VIP öldü (ceset kalır)');
      // Tek saklanan bütün görevleri bitirdiği için tur da biter (+2 hayatta kalma bonusu)
      const gained = fakeRoom.players.get('s1').score - scoreBefore;
      const survive = gv.ended ? UNIT_CONFIG.SURVIVE_POINTS : 0;
      ok(gained === UNIT_CONFIG.VIP_POINTS + survive && events.some((e) => e.ev === 'game:notify' && e.room === 's1' && e.d.text.includes(`+${UNIT_CONFIG.VIP_POINTS}`)),
        `VIP öldürünce +${UNIT_CONFIG.VIP_POINTS} puan (toplam +${gained}${survive ? `, tur bittiği için +${survive} hayatta kalma dahil` : ''})`);
      gv.stop();
    }

    // Silinen NPC bir saklananın VIP'siyse yeni VIP atanır
    const g2 = new Game({ io: fakeIo, room: fakeRoom, config: UNIT_CONFIG, seekerId: 's0', onEnd() {} });
    g2.start();
    clearInterval(g2.timer);
    g2.beginPlayPhase();
    const t2 = g2.tasks.get('s1');
    t2.stage = 'vip';
    const origRand2 = Math.random;
    Math.random = () => 0.999999; // Fisher-Yates hiç takas yapmaz -> npcs[0..3] silinir
    let vipReassignedOk = false;
    try {
      const aliveNpcs2 = g2.chars.filter((c) => !c.ownerId && !c.dead);
      const targetVip = aliveNpcs2[0];
      t2.vipId = targetVip.id;
      g2.endsAt = Date.now() + 30000;
      g2.handleUseSkill('s0');
      const stillExists = g2.chars.some((c) => c.id === targetVip.id);
      const newVipExists = g2.chars.some((c) => c.id === t2.vipId && !c.ownerId && !c.dead);
      vipReassignedOk = !stillExists && t2.vipId !== targetVip.id && newVipExists;
    } finally {
      Math.random = origRand2;
    }
    ok(vipReassignedOk, 'Kalabalığı Azalt saklananın VIP NPC\'sini silince otomatik yeni VIP atandı');
    g.stop();
    g2.stop();

    // ---------- BİRİM TESTİ: Aktif VIP görünürlüğü (çatı altı dahil), -10 ceza ve Radar sis/VIP ayrımı ----------
    {
      const events = [];
      const recIo = { to(room) { const api = { emit(ev, d) { events.push({ room, ev, d }); }, except() { return api; } }; return api; } };
      const fakeRoom3 = {
        code: 'T3',
        players: new Map([
          ['s0', { id: 's0', name: 'Avci', score: 0 }],
          ['s1', { id: 's1', name: 'Sak1', score: 0 }],
          ['s2', { id: 's2', name: 'Sak2', score: 0 }],
        ]),
      };
      const g3 = new Game({ io: recIo, room: fakeRoom3, config: UNIT_CONFIG, seekerId: 's0', onEnd() {} });
      g3.start();
      clearInterval(g3.timer);
      g3.beginPlayPhase();

      const t1 = g3.tasks.get('s1');
      const t2b = g3.tasks.get('s2');
      ok(t1.vipId !== t2b.vipId, 'İki saklananın VIP hedefi asla aynı değil');

      // 1) Henüz heykel görevi bitmemiş (aktif olmayan) VIP vurulursa normal masum NPC gibi -2 puan
      const inactiveVip = g3.charById.get(t2b.vipId);
      inactiveVip.x = 700; inactiveVip.y = 200; inactiveVip.underRoof = false;
      g3.handleShoot('s0', 700, 200);
      ok(
        fakeRoom3.players.get('s0').score === -2 && fakeRoom3.players.get('s0').stats.hitNpcs === 1 && fakeRoom3.players.get('s0').stats.hitVips === 0,
        'Aktif olmayan VIP vurulunca normal masum NPC gibi -2 puan sayıldı',
      );
      g3.gunLockedUntil = 0;

      // 2) s1 heykel görevini bitirince VIP aktif olur; kapalı alanda (çatı altında) bile avcıya görünür!
      t1.diamonds = 3; t1.statue = true; t1.stage = 'vip';
      const activeVip = g3.charById.get(t1.vipId);
      const roof0 = map.roofs[0];
      activeVip.x = roof0.x + 80; activeVip.y = roof0.y + 80; activeVip.underRoof = true;
      g3.seekerMouse = null;
      events.length = 0;
      g3.broadcastState(Date.now());
      const seekerStateMsg = events.find((e) => e.room === 's0' && e.ev === 'game:state');
      ok(
        seekerStateMsg && seekerStateMsg.d.c.some((e) => e[0] === activeVip.id)
        && seekerStateMsg.d.vips && seekerStateMsg.d.vips.some((v) => v[0] === activeVip.id && v[1] === 3 && v.length === 2),
        'Aktif VIP kapalı alanda bile (nişangâh olmadan) avcıya 👑 3/3 canla görünür ve sahibi gizlidir',
      );

      // 3) Radar Bombası: çatı + sis içindeki saklananları sayar, NPC ve aktif VIP'yi saymaz!
      const h1Char = g3.charById.get(g3.players.get('s1').charId);
      const h2Char = g3.charById.get(g3.players.get('s2').charId);
      h1Char.x = roof0.x + 70; h1Char.y = roof0.y + 70; h1Char.underRoof = true;
      h2Char.x = roof0.x + 90; h2Char.y = roof0.y + 70; h2Char.underRoof = true;
      g3.smokes.push({ id: 99, x: h2Char.x, y: h2Char.y, r: 90, expiresAt: Date.now() + 10000, totalMs: 10000 });
      g3.radarReadyAt = 0;
      g3.handleUseSkill('s0', { skillId: 'radar', x: roof0.x + 80, y: roof0.y + 75 });
      g3.radars[0].landAt = Date.now() - 1;
      g3.lastTick = Date.now() - 50;
      g3.tick();
      ok(
        g3.radars[0].landed && g3.radars[0].count === 2,
        `Radar Bombası çatı ve sis içindeki 2 gerçek oyuncuyu saydı, içerdeki aktif VIP ve NPC'leri saymadı (sayı: ${g3.radars[0].count})`,
      );

      // 4) Avcı aktif VIP'yi vurursa -10 puan alır, 2 sn kilitlenir, saklanana 3/3 canlı yeni aktif VIP atanır
      const scoreBeforeVipHit = fakeRoom3.players.get('s0').score;
      const oldActiveVipId = activeVip.id;
      g3.handleShoot('s0', activeVip.x, activeVip.y);
      ok(
        fakeRoom3.players.get('s0').score === scoreBeforeVipHit - 10
        && fakeRoom3.players.get('s0').stats.hitVips === 1
        && g3.gunLockedUntil > Date.now() + 1500,
        'Avcı aktif VIP\'yi vurunca -10 puan aldı ve silahı 2 sn kilitlendi',
      );
      ok(
        t1.vipId !== null && t1.vipId !== oldActiveVipId && t1.vipId !== t2b.vipId && t1.vipHits === 0,
        'Saklanana diğerleriyle çakışmayan, 3/3 canlı yeni aktif VIP atandı',
      );
      g3.stop();
    }

    all.forEach((s) => s.disconnect());
  } catch (e) {
    console.error('TEST CRASH', e);
    fails++;
  }

  console.log('--- sunucu stderr ---\n' + (serverErr || '(boş)'));
  if (serverErr.trim()) fails++;
  server.kill();
  console.log(fails ? `\n❌ ${fails} FAIL` : '\n🎉 ALL ABILITY TESTS PASS');
  process.exit(fails ? 1 : 0);
})();
