// ============================================================
//  Parça 2 otomatik testi
//  Kullanım:  node test/sim.js
//  Kendi sunucusunu ayrı bir portta başlatır, 10 sahte oyuncu bağlar ve
//  şunları kontrol eder:
//   - NPC sayısı, ID karıştırma, oyuncu karakterlerinin ilk/son sırada olmaması
//   - Avcıya giden durumda çatı altındaki karakterlerin OLMAMASI
//   - Durumda "gerçek oyuncu" bilgisinin olmaması
//   - Saniyede ~20 güncelleme, sunucu tick süresi
//   - Saklananın hareketi, avcının ateşi (oyuncu/NPC/boşa) ve puanlar
// ============================================================
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const { MAPS } = require('../game/maps');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const N = 10;
const map = MAPS.square;

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? '✅' : '❌'} ${msg}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const underRoof = (x, y) => map.roofs.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
const once = (s, ev, ms = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`zaman aşımı: ${ev}`)), ms);
  s.once(ev, (d) => { clearTimeout(t); res(d); });
});

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), SKILL_PICK_TIME: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });
  await new Promise((res) => server.stdout.once('data', res));

  const clients = [];
  try {
    for (let i = 0; i < N; i++) {
      const s = io(URL, { transports: ['websocket'], forceNew: true });
      await once(s, 'connect');
      s.inits = null;
      s.states = [];
      s.notifies = [];
      s.shots = 0;
      s.scores = null;
      s.on('game:init', (d) => { s.init = d; });
      s.on('game:state', (d) => { s.states.push({ at: Date.now(), d }); if (s.states.length > 400) s.states.shift(); });
      s.on('game:notify', (d) => s.notifies.push(d));
      s.on('game:shot', () => s.shots++);
      s.on('game:scores', (d) => { s.scores = d; });
      s.on('game:eliminated', () => { s.eliminated = true; });
      clients.push(s);
    }

    // Oda kur + katıl + hazır
    const { code } = await new Promise((res) => clients[0].emit('room:create', { nick: 'P0' }, res));
    for (let i = 1; i < N; i++) {
      const r = await new Promise((res) => clients[i].emit('room:join', { nick: 'P' + i, code }, res));
      if (!r.ok) throw new Error(r.error);
    }
    // 9 saklanan: Normal'de yaklaşık 148 NPC; lider "Çok" seçince 148 × 1,5 = 222 → üst sınır 200
    await sleep(200);
    const snap0 = await new Promise((res) => { clients[1].once('room:update', res); clients[0].emit('room:settings', { npcDensity: 'high' }); });
    check(snap0.settings.npcDensity === 'high' && snap0.npcEstimate === 200, `Lider NPC yoğunluğunu "Çok" yaptı, lobide "yaklaşık ${snap0.npcEstimate} NPC" yazıyor`);
    for (const s of clients) s.emit('player:toggleReady');
    await sleep(800);

    // ---------- Başlangıç verisi ----------
    check(clients.every((s) => s.init), 'Herkes game:init aldı');
    const seekers = clients.filter((s) => s.init.role === 'seeker');
    const hiders = clients.filter((s) => s.init.role === 'hider');
    check(seekers.length === 1 && hiders.length === N - 1, `1 avcı, ${N - 1} saklanan`);
    const seeker = seekers[0];
    const total = seeker.init.appearances.length;
    const expectedNpc = Math.min(200, Math.round(Math.min(150, 40 + 12 * hiders.length) * 1.5));
    check(total === expectedNpc + hiders.length, `Karakter sayısı ${total} = ${expectedNpc} NPC + ${hiders.length} oyuncu`);
    check(seeker.init.youCharId === null, 'Avcının karakteri yok (youCharId=null)');

    const order = seeker.init.appearances.map((a) => a[0]);
    const playerIds = hiders.map((h) => h.init.youCharId);
    const firstLast = new Set([order[0], order[order.length - 1]]);
    check(playerIds.every((id) => !firstLast.has(id)), 'Oyuncu karakterleri listede ilk ya da son sırada değil');
    check(new Set(playerIds).size === playerIds.length, 'Her saklananın farklı ID\'si var');
    const sortedIds = [...order].sort((a, b) => a - b);
    check(JSON.stringify(order) !== JSON.stringify(sortedIds), 'ID\'ler karıştırılmış (sıralı değil)');
    check(seeker.init.appearances.every((a) => a.length === 4), 'Görünüm verisinde gizli alan yok');

    // ---------- Durum akışı ----------
    await sleep(5000);
    const sStates = seeker.states.slice(-80);
    let leaked = 0;
    for (const { d } of sStates) for (const e of d.c) if (underRoof(e[1], e[2])) leaked++;
    check(leaked === 0, `Avcının ağ trafiğinde çatı altında karakter yok (${sStates.length} paket tarandı, sızıntı: ${leaked})`);

    const hStates = hiders[0].states.slice(-80);
    let hiddenSeen = 0;
    for (const { d } of hStates) for (const e of d.c) if (underRoof(e[1], e[2])) hiddenSeen++;
    check(hiddenSeen > 0, `Saklananlar çatı altındakileri görüyor (ortalama ${(hiddenSeen / hStates.length).toFixed(1)} karakter/paket)`);
    check(hStates.every(({ d }) => d.c.length === total && d.c.every((e) => e.length >= 4 && e.length <= 6)),
      'Durum girdileri 4–6 elemanlı kısa diziler, gerçek oyuncu bayrağı yok');
    check(hStates.every(({ d }) => d.c.every((e) => e.every(Number.isInteger))), 'Konum, açı ve ilerleme tam sayı');
    check(hStates.every(({ d }) => d.c.every((e) => e[3] >= 0 && e[3] < 360)), 'Açı 0..359 derece');
    check(hStates.every(({ d }) => !d.looks && d.t === undefined), 'Durum paketinde kıyafet/şapka/ten ve gereksiz alan yok');
    check(hStates.every(({ d }) => d.g === undefined), 'Saklananlara silah bilgisi gitmiyor');

    const span = (sStates[sStates.length - 1].at - sStates[0].at) / (sStates.length - 1);
    check(span > 45 && span < 56, `Güncelleme aralığı ~50 ms (ölçülen: ${span.toFixed(1)} ms)`);

    const bytes = JSON.stringify(hStates[hStates.length - 1].d).length;
    const zipped = require('zlib').deflateRawSync(JSON.stringify(hStates[hStates.length - 1].d)).length;
    check(bytes < 4500, `Paket boyutu ${bytes} bayt (${total} karakter; eski biçimde ~5800) → sıkıştırılmış ~${zipped} bayt, oyuncu başına ~${((zipped * 20) / 1024).toFixed(1)} KB/sn`);

    // NPC'ler hareket ediyor mu; ilerleme halkası SADECE heykel incelemesi (kenara <= 25 br)
    // ya da çatı altında kıyafet değiştirme sırasında mı
    const last = hStates[hStates.length - 1].d.c;
    const moving = last.filter((e) => e[4] & 1).length;
    check(moving > 5, `NPC'ler yürüyor (${moving} karakter hareket halinde)`);
    const edgeDist = (e, s) => Math.hypot(e[1] - s.x, e[2] - s.y) - s.r;
    let statueRings = 0, roofRings = 0, badRings = 0, maxPerStatue = 0;
    const badSamples = [];
    for (const { d } of hiders[0].states) {
      const perStatue = new Map();
      for (const e of d.c) {
        if (e.length < 6 || (e[4] & 2)) continue; // 6. eleman = halka yüzdesi
        const st = map.statues.find((s) => edgeDist(e, s) <= 25.2);
        if (st) { statueRings++; perStatue.set(st.id, (perStatue.get(st.id) || 0) + 1); }
        else if (underRoof(e[1], e[2])) roofRings++;
        else { badRings++; if (badSamples.length < 3) badSamples.push(`#${e[0]} (${e[1]},${e[2]})`); }
      }
      for (const n of perStatue.values()) maxPerStatue = Math.max(maxPerStatue, n);
    }
    check(statueRings > 0, `Heykel inceleyen NPC'lerde halka var (${statueRings} örnek)`);
    check(badRings === 0, `Heykel/çatı dışında hiç halka yok (hatalı: ${badRings}${badSamples.length ? ' ' + badSamples.join(', ') : ''}; çatı altı kıyafet: ${roofRings})`);
    check(maxPerStatue <= 3, `Bir heykeli aynı anda en fazla 3 karakter inceliyor (en çok: ${maxPerStatue})`);

    // ---------- Saklanan hareketi ----------
    const mover = hiders[1];
    const myId = mover.init.youCharId;
    const posOf = (s, id) => {
      const st = s.states[s.states.length - 1].d.c.find((e) => e[0] === id);
      return st ? { x: st[1], y: st[2] } : null;
    };
    const dir = posOf(mover, myId).x < map.width / 2 ? 'r' : 'l';
    const p0 = posOf(mover, myId);
    mover.emit('game:input', { [dir]: true });
    await sleep(1000);
    mover.emit('game:input', {});
    await sleep(150);
    const p1 = posOf(mover, myId);
    const moved = Math.abs(p1.x - p0.x);
    check(moved > 25 && moved < 70, `Saklanan 1 sn'de ${moved.toFixed(1)} birim yürüdü (hız 55, engel/itme olabilir)`);

    // ---------- Ateş: boşa ----------
    const seekerVisible = () => seeker.states[seeker.states.length - 1].d.c;
    const allNow = () => hiders[0].states[hiders[0].states.length - 1].d.c;
    // Herkesten uzak bir nokta bul
    let empty = null;
    for (let tries = 0; tries < 500 && !empty; tries++) {
      const x = 40 + Math.random() * (map.width - 80), y = 40 + Math.random() * (map.height - 80);
      if (underRoof(x, y)) continue;
      if (allNow().every((e) => Math.hypot(e[1] - x, e[2] - y) > 80)) empty = { x, y };
    }
    const shots0 = hiders[0].shots;
    seeker.emit('game:shoot', empty);
    await sleep(120);
    seeker.emit('game:shoot', empty); // kilitli olmalı (0,5 sn)
    await sleep(200);
    check(hiders[0].shots - shots0 === 1, 'Boşa ateş → 0,5 sn kilit (ikinci atış yok sayıldı)');
    await sleep(500);

    // ---------- Ateş: masum NPC ----------
    const players = new Set(playerIds);
    const npc = seekerVisible().find((e) => !players.has(e[0]) && !(e[4] & 2) &&
      allNow().filter((o) => o[0] !== e[0] && !(o[4] & 2)).every((o) => Math.hypot(o[1] - e[1], o[2] - e[2]) > 30));
    const n0 = seeker.notifies.length;
    seeker.emit('game:shoot', { x: npc[1], y: npc[2] });
    await sleep(250);
    const nn = seeker.notifies.slice(n0);
    check(nn.some((n) => n.kind === 'npc'), `Masum NPC vuruldu: "${(nn.find((n) => n.kind === 'npc') || {}).text}"`);
    const seekerScore = () => seeker.scores.find((p) => p.role === 'seeker').score;
    check(seekerScore() === -2, `Avcı puanı -2 (${seekerScore()})`);
    check(seeker.states[seeker.states.length - 1].d.g > 1500, 'NPC vurunca silah ~2 sn kilitli');
    const corpse = allNow().find((e) => e[0] === npc[0]);
    check(corpse && (corpse[4] & 2), 'Vurulan NPC ceset olarak yerde');
    await sleep(2100);

    // ---------- Ateş: gerçek oyuncu ----------
    // Açıkta ve yanında kimse olmayan bir saklanan bulmak için biraz bekle
    let victim = null, vpos = null;
    for (let tries = 0; tries < 60 && !victim; tries++) {
      const all = allNow();
      for (const h of hiders) {
        if (h.eliminated) continue;
        const e = all.find((x) => x[0] === h.init.youCharId);
        if (!e || underRoof(e[1], e[2])) continue;
        const crowd = all.filter((o) => o[0] !== e[0] && !(o[4] & 2) && Math.hypot(o[1] - e[1], o[2] - e[2]) < 30);
        if (crowd.length === 0) { victim = h; vpos = e; break; }
      }
      if (!victim) await sleep(100);
    }
    check(!!victim, 'Açıkta vurulabilecek bir saklanan bulundu');
    if (victim) {
      const n1 = seeker.notifies.length;
      seeker.emit('game:shoot', { x: vpos[1], y: vpos[2] });
      await sleep(300);
      const nv = seeker.notifies.slice(n1).find((n) => n.kind === 'caught');
      check(!!nv, `Oyuncu yakalandı: "${nv && nv.text}"`);
      check(victim.eliminated === true, 'Vurulan oyuncuya game:eliminated gitti');
      check(seekerScore() === 3, `Avcı puanı -2 + 5 = 3 (${seekerScore()})`);
      const vs = seeker.scores.find((p) => p.name === victim.scores.find((q) => q.id === victim.id).name);
      check(vs && vs.out, 'Puan tablosunda vurulan oyuncu elendi olarak görünüyor');
    }

    // ---------- Sunucu performansı ----------
    // NPC formülü örnekleri
    const { Game, npcCountFor } = require('../game/Game');
    const CONFIG = require('./unitConfig');
    const ex = [1, 2, 4, 6, 9].map((h) => npcCountFor(CONFIG, h, 'normal'));
    check(ex.join(',') === '52,64,88,112,148', `Temel NPC = 40 + 12 × saklanan: 1→52, 2→64, 4→88, 6→112, 9→148 (${ex.join(', ')})`);
    check(npcCountFor(CONFIG, 20, 'normal') === 150, 'Normal: en fazla 150 NPC');
    check(npcCountFor(CONFIG, 2, 'low') === 48 && npcCountFor(CONFIG, 9, 'low') === 111, 'Az: temel × 0,75 (2→48, 9→111)');
    check(npcCountFor(CONFIG, 2, 'high') === 96 && npcCountFor(CONFIG, 9, 'high') === 200 && npcCountFor(CONFIG, 20, 'high') === 200, 'Çok: temel × 1,5, en fazla 200 (2→96, 9→200)');

    // Tick süresini doğrudan ölç (10 oyuncu + 200 NPC)
    const fakeEmit = { emit() {}, except() { return fakeEmit; } };
    const fakeIo = { to() { return fakeEmit; } };
    const fakeRoom = { code: 'TEST', players: new Map() };
    for (let i = 0; i < 10; i++) fakeRoom.players.set('s' + i, { id: 's' + i, name: 'P' + i, score: 0 });
    const g = new Game({ io: fakeIo, room: fakeRoom, config: CONFIG, npcDensity: 'high', onEnd() {} });
    g.start();
    clearTimeout(g.timer);
    g.beginPlayPhase();
    const t0 = process.hrtime.bigint();
    const TICKS = 2000;
    for (let i = 0; i < TICKS; i++) { g.lastTick = Date.now() - 50; g.tick(); }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / TICKS;
    g.stop();
    check(g.chars.length === 200 + 9, `Performans testi 200 NPC + 9 saklanan ile (${g.chars.length} karakter)`);
    check(ms < 5, `Sunucu tick süresi ${ms.toFixed(3)} ms (bütçe 50 ms, ${g.chars.length} karakter)`);

    // Hiçbir karakter engelin içinde ya da harita dışında değil (gerçek mesafe ile)
    const insideObstacle = (c, pad) => g.obstacles.some((o) => {
      if (o.type === 'circle') return Math.hypot(c.x - o.x, c.y - o.y) < o.r + pad;
      const cx = Math.max(o.x, Math.min(c.x, o.x + o.w));
      const cy = Math.max(o.y, Math.min(c.y, o.y + o.h));
      return Math.hypot(c.x - cx, c.y - cy) < pad;
    });
    const bad = g.chars.filter((c) => c.x < 0 || c.y < 0 || c.x > map.width || c.y > map.height || insideObstacle(c, CONFIG.CHAR_RADIUS - 1.5));
    check(bad.length === 0, `${TICKS} tick sonra engel içinde/harita dışında karakter yok (${bad.length})`);
  } finally {
    for (const s of clients) s.close();
    server.kill();
  }

  if (serverErr.trim()) {
    console.log('Sunucu stderr:\n' + serverErr);
    failures++;
  }
  console.log(failures ? `\n❌ ${failures} kontrol başarısız` : '\n🎉 Bütün kontroller geçti');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
