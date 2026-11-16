// ============================================================
//  Lobi ayarları testi: lider tur sayısı / tur süresini değiştirir,
//  herkes görür, hazırlıklar sıfırlanır; 5 tur × 1 dk maç oynanır.
//  Kullanım: npm run test:settings   (~5,5 dakika sürer)
// ============================================================
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PROJECT = path.join(__dirname, '..');
const PORT = 3459;
const URL = `http://localhost:${PORT}`;

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (s, ev, ms = 12000, cond = () => true) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`zaman aşımı: ${ev}`)); }, ms);
  const h = (d) => { if (!cond(d)) return; clearTimeout(t); s.off(ev, h); res(d); };
  s.on(ev, h);
});
const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));

function mk(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.nick = name;
  s.room = null;
  s.inits = [];
  s.on('room:joined', (r) => { s.room = r; });
  s.on('room:update', (r) => { s.room = r; });
  s.on('game:init', (d) => { s.init = d; s.inits.push({ t: Date.now(), d }); });
  return s;
}

(async () => {
  // Ortam değişkeniyle tur süresi geçersiz kılınmaz: süre lobi ayarından gelir
  const env = { ...process.env, PORT: String(PORT), ROUND_END_MS: '1200', FINAL_MS: '1200', SKILL_PICK_TIME: '2' };
  delete env.ROUND_TIME;
  const server = spawn(process.execPath, [path.join(PROJECT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });
  await new Promise((res) => server.stdout.once('data', res));

  try {
    const A = mk('Ayse'), B = mk('Burak'), C = mk('Ceren');
    const all = [A, B, C];
    await Promise.all(all.map((s) => once(s, 'connect')));
    const { code } = await emit(A, 'room:create', { nick: 'Ayse' });
    await emit(B, 'room:join', { nick: 'Burak', code });
    await emit(C, 'room:join', { nick: 'Ceren', code });
    await sleep(200);

    ok(all.every((s) => s.room.settings.rounds === 3 && s.room.settings.roundMinutes === 3), 'Varsayılan ayarlar: 3 tur · 3 dk (herkes görüyor)');
    ok(A.room.settingsLimits.roundsMin === 1 && A.room.settingsLimits.roundsMax === 10 && A.room.settingsLimits.minuteOptions.join(',') === '1,2,3,4,5', 'Sınırlar: 1–10 tur, 1/2/3/4/5 dk');

    // Lider olmayan değiştiremez
    B.emit('room:settings', { rounds: 7 });
    await sleep(250);
    ok(all.every((s) => s.room.settings.rounds === 3), 'Lider olmayan oyuncu ayarı değiştiremedi');

    // Geçersiz değerler reddedilir
    A.emit('room:settings', { rounds: 11 });
    A.emit('room:settings', { roundMinutes: 7 });
    A.emit('room:settings', { rounds: 0 });
    await sleep(250);
    ok(all.every((s) => s.room.settings.rounds === 3 && s.room.settings.roundMinutes === 3), 'Geçersiz değerler (11 tur, 7 dk, 0 tur) reddedildi');

    // B ve C hazır; lider ayarı değiştirince hazırlıklar sıfırlanır, herkes anında görür
    B.emit('player:toggleReady');
    C.emit('player:toggleReady');
    await sleep(250);
    ok(A.room.players.filter((p) => p.ready).length === 2, 'B ve C hazır');
    const seenAt = [];
    const tChange = Date.now();
    const waits = all.map((s) => once(s, 'room:update', 2000, (r) => r.settings.rounds === 5).then(() => seenAt.push(Date.now() - tChange)));
    A.emit('room:settings', { rounds: 5 });
    await Promise.all(waits);
    ok(all.every((s) => s.room.settings.rounds === 5), `Lider 5 tur seçti, herkes anında gördü (en geç ${Math.max(...seenAt)} ms)`);
    ok(all.every((s) => s.room.players.every((p) => !p.ready)), 'Ayar değişince herkesin hazırlık durumu sıfırlandı');
    A.emit('room:settings', { roundMinutes: 1 });
    await once(C, 'room:update', 2000, (r) => r.settings.roundMinutes === 1);
    await sleep(100);
    ok(all.every((s) => s.room.settings.roundMinutes === 1 && s.room.settings.rounds === 5), 'Lider 1 dk seçti, herkes "5 tur · 1 dk" görüyor');

    // NPC yoğunluğu: varsayılan Normal; 3 oyuncu → 2 saklanan → 64 NPC
    ok(all.every((s) => s.room.settings.npcDensity === 'normal' && s.room.npcEstimate === 64), `NPC yoğunluğu varsayılan "Normal", lobide "yaklaşık ${A.room.npcEstimate} NPC"`);
    ok(A.room.settingsLimits.densityOptions.map((d) => d.label).join(',') === 'Az,Normal,Çok', 'Yoğunluk seçenekleri: Az, Normal, Çok');
    B.emit('room:settings', { npcDensity: 'high' });
    A.emit('room:settings', { npcDensity: 'cokcok' });
    await sleep(250);
    ok(all.every((s) => s.room.settings.npcDensity === 'normal'), 'Lider olmayan yoğunluğu değiştiremedi, geçersiz değer reddedildi');
    B.emit('player:toggleReady');
    await sleep(150);
    A.emit('room:settings', { npcDensity: 'high' });
    await once(C, 'room:update', 2000, (r) => r.settings.npcDensity === 'high');
    await sleep(100);
    ok(all.every((s) => s.room.settings.npcDensity === 'high' && s.room.npcEstimate === 96), `Lider "Çok" seçti, herkes "yaklaşık ${C.room.npcEstimate} NPC" görüyor (64 × 1,5)`);
    ok(all.every((s) => s.room.players.every((p) => !p.ready)), 'Yoğunluk değişince hazırlıklar sıfırlandı');
    A.emit('room:settings', { npcDensity: 'low' });
    await once(C, 'room:update', 2000, (r) => r.settings.npcDensity === 'low');
    ok(C.room.npcEstimate === 48, `"Az" → yaklaşık ${C.room.npcEstimate} NPC (64 × 0,75)`);
    A.emit('room:settings', { npcDensity: 'normal' });
    await once(C, 'room:update', 2000, (r) => r.settings.npcDensity === 'normal');

    // ---------- MAÇ: 5 tur × 1 dk ----------
    const roundEnds = [];
    A.on('round:end', (d) => roundEnds.push({ t: Date.now(), d }));
    all.forEach((s) => s.emit('player:toggleReady'));
    const playStarts = [];
    A.on('game:playStart', (d) => playStarts.push({ t: Date.now(), d }));
    const fin = await once(A, 'match:end', 7 * 60 * 1000);

    ok(A.inits.length === 5, `5 tur oynandı (${A.inits.length})`);
    ok(A.inits.every((x, i) => x.d.round === i + 1 && x.d.totalRounds === 5), 'Her turda "Tur N/5" bilgisi doğru');
    ok(A.inits.every((x) => x.d.roundTime === 60), 'Tur süresi 60 sn (1 dk)');
    ok(A.inits.every((x) => x.d.appearances.length === 64 + 2), 'Her turda 64 NPC + 2 saklanan (Normal yoğunluk)');
    ok(A.inits.every((x) => x.d.skillsCfg.cullUnlockLeft === 30), 'Avcı yeteneği 1 dk\'lık turda 0:30 kala açılıyor');
    ok(roundEnds.every((r) => r.d.reason === 'time'), 'Bütün turlar süre dolunca bitti');
    const durations = roundEnds.map((r, i) => (r.t - playStarts[i].t) / 1000);
    ok(durations.length === 5 && durations.every((d) => d > 59 && d < 61.5), `Her tur ~60 sn sürdü (${durations.map((d) => d.toFixed(1)).join(', ')})`);

    // Avcı sırası: A, B, C, A, B düzeni (ilk 3 farklı, 4. = 1., 5. = 2.)
    const order = A.inits.map((x) => x.d.seekerName);
    ok(new Set(order.slice(0, 3)).size === 3 && order[3] === order[0] && order[4] === order[1], `Avcı sırası döngüsel: ${order.join(', ')}`);
    // Tur sonu ekranında sıradaki tur bilgisi
    const nexts = roundEnds.map((r) => r.d.next);
    ok(nexts.slice(0, 4).every((n, i) => n && n.round === i + 2 && n.totalRounds === 5 && n.seekerName === order[i + 1]) && nexts[4] === null,
      'Tur sonunda "Tur N/5 · Avcı: X" (sıradaki) bilgisi doğru');
    ok(fin.players.length === 3, 'Final tablosu geldi');
    const ended = await once(A, 'game:ended', 6000);
    ok(ended.settings.rounds === 5 && ended.settings.roundMinutes === 1, 'Lobiye dönünce ayarlar korunuyor (5 tur · 1 dk)');

    all.forEach((s) => s.disconnect());
  } catch (e) {
    console.error('TEST CRASH', e);
    fails++;
  }
  console.log('--- sunucu stderr ---\n' + (serverErr || '(boş)'));
  if (serverErr.trim()) fails++;
  server.kill();
  console.log(fails ? `\n${fails} FAIL` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
