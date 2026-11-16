// Parça 3 otomatik testi: 3 oyuncuyla tam maç (görevler, puanlar, turlar, final)
// Kullanım: npm run test:match  (kendi sunucusunu 3457 portunda kısa tur süresiyle açar)
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PROJECT = path.join(__dirname, '..');
const PORT = 3457;
const URL = `http://localhost:${PORT}`;
const ROUND_TIME = 180;
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (s, ev, ms = 8000, cond = () => true) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`zaman aşımı: ${ev}`)); }, ms);
  const h = (d) => { if (!cond(d)) return; clearTimeout(t); s.off(ev, h); res(d); };
  s.on(ev, h);
});
const emit = (s, ev, d) => new Promise((r) => s.emit(ev, d, r));

let map = null;
const underRoof = (x, y) => map.roofs.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);

function mk(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  s.nick = name;
  s.state = null; s.diamonds = []; s.tasks = null; s.init = null; s.scores = null; s.hints = []; s.notes = []; s.statueChanges = 0;
  s.on('game:init', (d) => { s.init = d; s.state = null; s.diamonds = []; s.tasks = null; });
  s.on('game:state', (d) => { s.state = d; });
  s.on('game:diamonds', (d) => { s.diamonds = d; });
  s.on('game:tasks', (d) => { s.tasks = d; });
  s.on('game:scores', (d) => { s.scores = d; });
  s.on('game:hint', (d) => s.hints.push(d.text));
  s.on('game:notify', (d) => s.notes.push(d));
  s.on('game:statue', (d) => { s.statueChanges++; s.lastStatueChange = d; });
  return s;
}
const myPos = (s) => {
  if (!s.state || !s.init) return null;
  const c = s.state.c.find((e) => e[0] === s.init.youCharId);
  return c ? { x: c[1], y: c[2], dead: !!(c[4] & 2) } : null;
};
const charPos = (s, id) => {
  const c = s.state && s.state.c.find((e) => e[0] === id);
  return c ? { x: c[1], y: c[2], dead: !!(c[4] & 2) } : null;
};

// Basit yönlendirme: hedefe doğru tuşlara bas, takılınca kısa süre yana sap
async function walkTo(s, getTarget, within, timeout) {
  const t0 = Date.now();
  let lastPos = null, lastMove = Date.now(), detour = 0, detourUntil = 0;
  while (Date.now() - t0 < timeout) {
    const me = myPos(s); const tg = getTarget();
    if (!me || !tg) { await sleep(100); continue; }
    const dx = tg.x - me.x, dy = tg.y - me.y;
    if (Math.hypot(dx, dy) <= within) { s.emit('game:input', {}); await sleep(200); return true; }
    if (lastPos && Math.hypot(me.x - lastPos.x, me.y - lastPos.y) > 2.5) lastMove = Date.now();
    if (Date.now() - lastMove > 1200) { detour = (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2; detourUntil = Date.now() + 1000; lastMove = Date.now(); }
    let ang = Math.atan2(dy, dx) + (Date.now() < detourUntil ? detour : 0);
    s.emit('game:input', { r: Math.cos(ang) > 0.38, l: Math.cos(ang) < -0.38, d: Math.sin(ang) > 0.38, u: Math.sin(ang) < -0.38 });
    lastPos = me;
    await sleep(100);
  }
  s.emit('game:input', {});
  return false;
}

async function interact(s, cond, timeout) {
  s.emit('game:input', {});
  await sleep(120);
  s.emit('game:interact');
  try { await once(s, 'game:tasks', timeout, cond); return true; } catch { return false; }
}

const score = (s, nick) => (s.scores || []).find((p) => p.name === nick);

(async () => {
  const server = spawn(process.execPath, [path.join(PROJECT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), ROUND_TIME: String(ROUND_TIME), ROUND_END_MS: '1500', SKILL_PICK_TIME: '2' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
    const roundEnds = [];
    all.forEach((s) => s.emit('player:toggleReady'));
    await Promise.all(all.map((s) => once(s, 'game:init')));
    const play1 = Promise.all(all.map((s) => once(s, 'game:playStart')));
    all.filter((s) => s.init.role === 'hider').forEach((s) => s.emit('game:pickSkill', { skillId: s.init.skillOptions[0].id }));
    await play1;
    await sleep(400);
    map = A.init.map;
    A.on('round:end', (d) => roundEnds.push(d));

    // ---------- TUR 1 ----------
    ok(all.every((s) => s.init.round === 1 && s.init.totalRounds === 3), 'Tur 1/3 bilgisi geldi');
    let seeker = all.find((s) => s.init.role === 'seeker');
    let hiders = all.filter((s) => s.init.role === 'hider');
    ok(seeker && hiders.length === 2, `1 avcı (${seeker.nick}), 2 saklanan`);
    ok(all.every((s) => s.init.seekerName === seeker.nick), 'avcı adı herkese doğru gitti');
    const seekers = [seeker.nick];

    const H1 = hiders[0], H2 = hiders[1];
    // Avcının ekranında heykel başında ilerleme halkasıyla duran NPC'leri say
    const npcStatueRings = new Set();
    const ringWatch = (st) => {
      if (!st || !st.c) return;
      for (const e of st.c) {
        if (e[0] === H1.init.youCharId || e[0] === H2.init.youCharId || e.length < 6 || (e[4] & 2)) continue; // 6. eleman = halka %
        if (map.statues.some((s) => Math.hypot(s.x - e[1], s.y - e[2]) <= s.r + 40)) npcStatueRings.add(e[0]);
      }
    };
    seeker.on('game:state', ringWatch);
    ok(H1.tasks && H1.tasks.stage === 'diamonds' && H1.tasks.myDiamondIds === undefined, 'kişiye özel elmas listesi yok, görev diamonds');
    ok(H1.tasks.vipId === null, 'VIP hedefi heykelden önce gizli');
    const total = 2 * 3 + 6;
    ok(H1.diamonds.length === total, `toplam elmas ${H1.diamonds.length} = 2×3 + 6`);
    const roofD = H1.diamonds.filter((d) => underRoof(d[1], d[2])).length;
    ok(roofD >= 3 && roofD <= 7, `elmasların ~%40'ı çatı altında (${roofD}/${total})`);
    ok(
      seeker.diamonds.length === total && seeker.diamonds.filter((d) => underRoof(d[1], d[2])).length === roofD,
      `avcı çatı altındaki elmasları da nişangâh olmadan her zaman görür (${seeker.diamonds.length}/${total})`,
    );
    ok(seeker.tasks === null, 'avcıya görev listesi gitmedi');
    ok(!seeker.state.vips || seeker.state.vips.length === 0, 'heykel görevi bitmeden önce avcıya aktif VIP görünmez');

    // E: yakında elmas yok ipucu ("Yakında elmas yok")
    const me0 = myPos(H1);
    const nearAny = H1.diamonds.some((d) => Math.hypot(d[1] - me0.x, d[2] - me0.y) <= 40);
    if (!nearAny) {
      H1.emit('game:interact');
      await sleep(300);
      ok(H1.hints.includes('Yakında elmas yok'), 'yakında elmas yokken ipucu: "Yakında elmas yok"');
    }

    // Herhangi 3 elmas topla
    const anyTarget = () => {
      const me = myPos(H1); if (!me) return null;
      const list = [...H1.diamonds];
      list.sort((a, b) => Math.hypot(a[1] - me.x, a[2] - me.y) - Math.hypot(b[1] - me.x, b[2] - me.y));
      return list[0] ? { x: list[0][1], y: list[0][2] } : null;
    };
    const t1 = Date.now();
    let sparkles = 0;
    H1.on('game:sparkle', () => { sparkles++; });
    let seekerSparkles = 0;
    seeker.on('game:sparkle', () => { seekerSparkles++; });
    // Elmas anında alınır: E'den sonra görev hemen ilerler, ilerleme halkası (prog) hiç görünmez
    const myProg = () => { const c = H1.state && H1.state.c.find((e) => e[0] === H1.init.youCharId); return c && c.length >= 6 ? c[5] : -1; };
    const instantPick = async (i, whileWalking) => {
      let ringSeen = false;
      const watch = setInterval(() => { if (myProg() >= 0) ringSeen = true; }, 20);
      const tPress = Date.now();
      if (!whileWalking) { H1.emit('game:input', {}); await sleep(120); }
      H1.emit('game:interact');
      let got = false;
      try { await once(H1, 'game:tasks', 1000, (t) => t.diamonds >= i); got = true; } catch { /* yok */ }
      const ms = Date.now() - tPress;
      await sleep(150);
      clearInterval(watch);
      return { got, ms, ringSeen };
    };
    for (let i = 1; i <= 3; i++) {
      const reached = await walkTo(H1, anyTarget, 28, 40000);
      ok(reached, `elmas ${i}: yanına yüründü`);
      // 2. elması yürürken al: E'ye basarken yön tuşu basılı
      const walking = i === 2;
      if (walking) {
        const tg = anyTarget(); const me = myPos(H1);
        const ang = Math.atan2(tg.y - me.y, tg.x - me.x);
        H1.emit('game:input', { r: Math.cos(ang) > 0.38, l: Math.cos(ang) < -0.38, d: Math.sin(ang) > 0.38, u: Math.sin(ang) < -0.38 });
        await sleep(60);
      }
      let res = await instantPick(i, walking);
      if (walking) H1.emit('game:input', {});
      if (!res.got) {
        await walkTo(H1, anyTarget, 24, 30000);
        res = await instantPick(i, false);
      }
      ok(res.got && res.ms < 400, `elmas ${i}: E'ye basınca anında alındı (${res.ms} ms)${walking ? ' — yürürken' : ''}`);
      ok(!res.ringSeen, `elmas ${i}: ilerleme çubuğu/halkası çıkmadı`);
      if (i === 1) {
        ok(seeker.diamonds.length === total - 1, `elmas alınınca avcı da kaybolduğunu hemen gördü (${seeker.diamonds.length}/${total})`);
      }
    }
    ok(sparkles === 3 && seekerSparkles === 0, `her elmasta parlama efekti (${sparkles}), avcıya gitmedi`);
    ok(H1.notes.filter((n) => n.sfx === 'diamond').length === 3, 'her elmasta "ding" sesi (sfx: diamond)');
    console.log(`   (elmaslar ${((Date.now() - t1) / 1000).toFixed(0)} sn sürdü)`);
    await sleep(200);
    ok(H1.tasks.stage === 'statue', 'elmaslar bitince heykel görevi açıldı');
    ok(score(H1, H1.nick).score === 9 && score(H1, H1.nick).roundScore === 9, `elmas puanı 3×3 = ${score(H1, H1.nick).score}`);
    ok(H1.notes.some((n) => n.kind === 'good' && n.text.includes('Elmas')), 'kişisel "Elmas +3" bildirimi');

    // Haritada 6 küçük sabit heykel (tamamı açık alanda) ve ortada çeşme var; herhangi bir heykelin yanına yürü
    ok(!!map.fountain && !map.statue && Array.isArray(map.statues) && map.statues.length === 6, 'ortada çeşme ve 6 küçük sabit heykel var');
    ok(map.statues.every((s) => !underRoof(s.x, s.y)), '6 heykelin tamamı açık alanda (hiçbiri kapalı alanda değil)');
    // Açık alandaki heykellerden birine git; başı doluysa (3 inceleyen) diğerini dene
    const openStatues = map.statues.filter((s) => !underRoof(s.x, s.y));
    let st = null;
    for (let k = 0; k < openStatues.length * 2 && !st; k++) {
      const cand = openStatues[k % openStatues.length];
      if (!(await walkTo(H1, () => ({ x: cand.x, y: cand.y }), cand.r + 26, 40000))) continue;
      const h0 = H1.hints.length;
      H1.emit('game:input', {});
      await sleep(120);
      H1.emit('game:interact');
      await sleep(250);
      if (H1.hints.slice(h0).some((h) => h.includes('dolu'))) { console.log(`   (heykel ${cand.id} dolu, başka heykel deneniyor)`); continue; }
      st = cand;
    }
    ok(!!st, 'heykelin yanına yüründü');
    await sleep(250);
    H1.emit('game:input', { r: true });
    await sleep(300);
    H1.emit('game:input', {});
    ok(H1.hints.includes('Görev iptal edildi'), 'hareket edince görev iptal oldu');
    // Oyuncu incelemeden önce NPC'ler heykel inceledi (halka göründü) ama hiçbir heykel değişmedi
    ok(npcStatueRings.size > 0, `NPC'ler heykel başında ilerleme halkasıyla görüldü (${npcStatueRings.size} NPC)`);
    ok(H1.statueChanges === 0 && H2.statueChanges === 0 && seeker.statueChanges === 0, 'oyuncu incelemeden önce hiçbir heykel değişmedi (NPC incelemeleri değiştirmez)');
    // Heykeli incele (3 sn): iptal için yana yürüdükten sonra tekrar heykelin yanına yaklaş
    const before = H1.statueChanges;
    let inspectedOk = false;
    for (let k = 0; k < openStatues.length && !inspectedOk; k++) {
      const cand = k === 0 ? st : openStatues[k % openStatues.length];
      await walkTo(H1, () => ({ x: cand.x, y: cand.y }), cand.r + 22, 30000);
      if (await interact(H1, (t) => t.stage === 'vip', 4500)) {
        st = cand;
        inspectedOk = true;
      }
    }
    ok(inspectedOk, 'heykel 3 sn incelendi, VIP görevi açıldı');
    await sleep(300);
    ok(H1.statueChanges > before && seeker.statueChanges > 0 && H1.lastStatueChange && H1.lastStatueChange.id === st.id, 'incelenen heykel değişti ve herkese bildirildi');
    ok(score(H1, H1.nick).score === 13, `heykel puanı +4 → ${score(H1, H1.nick).score}`);
    ok(typeof H1.tasks.vipId === 'number', `VIP hedefi atandı: ${H1.tasks.vipId}`);
    ok(H2.tasks.vipId === null, 'diğer saklanan kendi VIP\'sini henüz görmüyor');
    const vipChar = H1.init.appearances.find((a) => a[0] === H1.tasks.vipId);
    ok(!!vipChar && H1.tasks.vipId !== H1.init.youCharId && H1.tasks.vipId !== H2.init.youCharId, 'VIP bir NPC (oyuncu değil)');

    // Heykel görevi bitince VIP aktif olur: avcı VIP'yi (kapalı alanda bile) 3 çentik canla görür
    const seekerVipEntry = (id) => (seeker.state && seeker.state.vips || []).find((v) => v[0] === id);
    const vipVisible = seeker.state.c.find((e) => e[0] === H1.tasks.vipId && !(e[4] & 2));
    const sv0 = seekerVipEntry(H1.tasks.vipId);
    ok(!!vipVisible && !!sv0 && sv0[1] === 3 && sv0.length === 2, 'aktif VIP avcıya (kapalı alanda bile) 3/3 canla ve sahibi gizli olarak göründü');
    ok(!H2.state.vips, 'diğer saklananlara aktif VIP listesi gönderilmez');

    // Avcı aktif VIP'yi vurursa -10 puan ceza alır, herkese bildirim gider ve saklanana tam canlı (3/3) yeni aktif VIP atanır
    const oldVip = H1.tasks.vipId;
    seeker.emit('game:shoot', { x: vipVisible[1], y: vipVisible[2] });
    try {
      await once(H1, 'game:tasks', 1500, (t) => t.vipId !== oldVip);
      ok(H1.tasks.vipId !== null && H1.tasks.vipId !== oldVip && H1.tasks.vipHits === 0, `avcı aktif VIP'yi vurdu → yeni hedef: ${H1.tasks.vipId} (3/3 can)`);
    } catch { ok(false, 'VIP vurulunca yeni hedef atanmadı'); }
    await sleep(200);
    ok(score(seeker, seeker.nick).roundScore === -10, `avcı aktif VIP vurunca -10 ceza aldı (${score(seeker, seeker.nick).roundScore})`);
    ok(seeker.notes.some((n) => n.text.includes('Avcı bir VIP\'yi vurdu')), 'herkese "😬 Avcı bir VIP\'yi vurdu (−10)" bildirimi gitti');
    ok(H1.notes.some((n) => n.text.includes('Hedefin değişti!')), 'saklanana "Hedefin değişti!" bildirimi gitti');
    const svNew = seekerVipEntry(H1.tasks.vipId);
    ok(!!svNew && svNew[1] === 3, 'yeni atanan VIP hemen aktif oldu ve avcıya 3/3 canla göründü');
    await sleep(2000);

    // VIP'yi 3 vuruşta öldür: VIP kaçmaz ama yürüyebilir, peşinden gidip her vuruşta E
    const vipTarget = () => { const c = charPos(H1, H1.tasks.vipId); return c && !c.dead ? c : null; };
    let punchSeenByH2 = 0;
    H2.on('game:punch', () => { punchSeenByH2++; });
    let seekerSawDamagedVip = false;
    const vipIdKilled = H1.tasks.vipId;
    const hitLog = [];
    const tVip = Date.now();
    while (!H1.tasks.vip && Date.now() - tVip < 90000) {
      if (H1.tasks.vipId !== vipIdKilled) break;
      if (!(await walkTo(H1, vipTarget, 27, 30000))) continue;
      const before = H1.tasks.vipHits;
      H1.emit('game:interact');
      try {
        await once(H1, 'game:tasks', 600, (t) => t.vipHits > before || t.vip);
        hitLog.push(H1.tasks.vip ? 3 : H1.tasks.vipHits);
        await sleep(100);
        const sv = seekerVipEntry(vipIdKilled);
        if (sv && sv[1] < 3) seekerSawDamagedVip = true;
      } catch { /* VIP uzaklaştı, tekrar yaklaş */ }
      await sleep(480); // iki vuruş arası en az 0,5 sn
    }
    ok(hitLog.join(',') === '1,2,3', `VIP tam 3 vuruşta öldü (vuruşlar: ${hitLog.join(',')})`);
    ok(seekerSawDamagedVip, 'avcı VIP\'ye yapılan vuruşlardan can çentiğinin azaldığını gördü');
    ok(H1.tasks.vipHits === 3 || H1.tasks.vip, 'görev listesi VIP 3/3');
    await sleep(300);
    ok(punchSeenByH2 === 3, `vuruş animasyonu diğer oyunculara da gitti (${punchSeenByH2} yumruk)`);
    ok(H1.tasks.stage === 'done', 'bütün görevler tamam');
    ok(score(H1, H1.nick).score === 18, `VIP puanı +5 → ${score(H1, H1.nick).score}`);
    const vipDead = charPos(H2, vipIdKilled);
    ok(vipDead && vipDead.dead, 'VIP cesedi herkes görüyor');
    ok(H1.tasks.vipId === null, 'görev bitince VIP işareti kalkar');
    H1.emit('game:interact');
    await sleep(300);
    ok(H1.hints.some((h) => h.includes('tamam')), 'görevler bitince E → bilgi ipucu');

    // Avcı diğer saklananı vurur → hayatta kalan tek saklanan görevleri bitirmiş → tur biter (tasks)
    await walkTo(H2, () => ({ x: 700, y: 620 }), 20, 40000);
    await sleep(300);
    const sBefore = score(seeker, seeker.nick).roundScore;
    const shootUntilDead = async (h) => {
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        const pos = myPos(h);
        if (!pos || pos.dead) return true;
        if (seeker.state && seeker.state.g > 0) { await sleep(100); continue; }
        seeker.emit('game:shoot', { x: pos.x, y: pos.y });
        await sleep(250);
      }
      return false;
    };
    const re1p = once(A, 'round:end', 40000);
    ok(await shootUntilDead(H2), `avcı ${H2.nick}'i vurdu`);
    const re1 = await re1p;
    ok(re1.reason === 'tasks', `tur 1 bitiş nedeni: ${re1.reason} (${re1.reasonText})`);
    const r1 = Object.fromEntries(re1.players.map((p) => [p.name, p]));
    ok(r1[H1.nick].roundScore === 20 && r1[H1.nick].alive, `${H1.nick} bu tur 18 + 2 hayatta kalma = ${r1[H1.nick].roundScore}`);
    ok(r1[seeker.nick].roundScore === sBefore + 5 && !r1[H2.nick].alive, `avcı +5 aldı (${sBefore} → ${r1[seeker.nick].roundScore}), ${H2.nick} elendi`);
    ok(r1[H1.nick].tasks.diamonds === 3 && r1[H1.nick].tasks.statue && r1[H1.nick].tasks.vip, 'tur özeti görevleri gösteriyor (💎 3/3 · 🗿 ✔ · 🎯 ✔)');
    ok(r1[seeker.nick].tasks === null, 'avcının görev özeti yok');

    // ---------- TUR 2 ve 3: avcı herkesi vurur ----------
    for (let round = 2; round <= 3; round++) {
      await Promise.all(all.map((s) => once(s, 'game:init', 6000)));
      const playNext = Promise.all(all.map((s) => once(s, 'game:playStart', 6000)));
      all.filter((s) => s.init.role === 'hider').forEach((s) => s.emit('game:pickSkill', { skillId: s.init.skillOptions[0].id }));
      await playNext;
      await sleep(400);
      seeker = all.find((s) => s.init.role === 'seeker');
      hiders = all.filter((s) => s.init.role === 'hider');
      ok(seeker.init.round === round && !seekers.includes(seeker.nick), `tur ${round}: yeni avcı ${seeker.nick}`);
      seekers.push(seeker.nick);
      ok(all.every((s) => s.scores && score(s, 'Ayse').roundScore === 0), 'tur puanı sıfırlandı, toplam korundu');
      // saklananlar açık alana yürür, avcı vurur
      await Promise.all(hiders.map((h, i) => walkTo(h, () => ({ x: 620 + i * 160, y: 620 }), 20, 40000)));
      await sleep(400);
      const rep = once(A, 'round:end', 70000);
      for (const h of hiders) ok(await shootUntilDead(h), `tur ${round}: avcı ${h.nick}'i vurdu`);
      const re = await rep;
      ok(re.reason === 'caught', `tur ${round} bitiş nedeni: ${re.reason}`);
      const rr = Object.fromEntries(re.players.map((p) => [p.name, p]));
      const npcHits = seeker.notes.filter((n) => n.kind === 'npc').length;
      ok(rr[seeker.nick].roundScore >= 10 - 2 * npcHits && rr[seeker.nick].roundScore <= 10, `avcı 2 oyuncu × 5 (NPC cezaları dahil) = ${rr[seeker.nick].roundScore}`);
      ok(re.players.filter((p) => p.role === 'hider').every((p) => !p.alive && p.roundScore === 0), 'elenen saklananlar hayatta kalma bonusu almadı');
      seeker.notes.length = 0;
    }
    ok(new Set(seekers).size === 3, `herkes bir kez avcı oldu: ${seekers.join(', ')}`);

    // ---------- FİNAL (LİDERLİK TABLOSU) ----------
    const fin = await once(A, 'match:end', 6000);
    ok(fin.players.length === 3 && fin.players[0].rank === 1 && fin.seconds === 15, `final liderlik tablosu sıralaması geldi (süre: ${fin.seconds} sn)`);
    const sorted = [...fin.players].every((p, i, a) => i === 0 || a[i - 1].score >= p.score);
    const tiesShareRank = [...fin.players].every((p, i, a) => i === 0 || (p.score === a[i - 1].score ? p.rank === a[i - 1].rank : p.rank === i + 1));
    ok(sorted && tiesShareRank, 'liderlik tablosu puana göre sıralı ve eşit puanlar aynı sırayı paylaşıyor');
    const expected = {};
    for (const re of roundEnds) for (const p of re.players) expected[p.name] = (expected[p.name] || 0) + p.roundScore;
    ok(fin.players.every((p) => p.score === expected[p.name]), `toplam puan = tur puanlarının toplamı (${fin.players.map((p) => `${p.name}:${p.score}`).join(', ')})`);
    const h1Final = fin.players.find((p) => p.name === H1.nick);
    const r1SeekerFinal = fin.players.find((p) => p.name === seekers[0]);
    ok(
      h1Final && h1Final.stats && h1Final.stats.diamonds === 3 && h1Final.stats.statues === 1 && h1Final.stats.vipsKilled === 1 && h1Final.stats.survivedRounds === 1,
      `liderlik tablosunda saklanan istatistikleri doğru (${JSON.stringify(h1Final && h1Final.stats)})`,
    );
    ok(
      r1SeekerFinal && r1SeekerFinal.stats && r1SeekerFinal.stats.hitVips >= 1 && r1SeekerFinal.stats.caughtPlayers >= 1,
      `liderlik tablosunda avcı istatistikleri doğru (${JSON.stringify(r1SeekerFinal && r1SeekerFinal.stats)})`,
    );
    // "Lobiye dön" butonu: bütün oyuncular basınca 15 sn beklemeden hemen lobiye dönülür
    const endedPromise = once(A, 'game:ended', 2500);
    all.forEach((s) => s.emit('match:returnLobby'));
    const ended = await endedPromise;
    ok(ended.state === 'lobby' && ended.players.every((p) => !p.ready), '"Lobiye dön" ile finalden hemen lobiye dönüldü, hazırlıklar sıfır');
    ok(ended.players.every((p) => p.score === expected[p.name]), 'lobide puanlar korunuyor');

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
