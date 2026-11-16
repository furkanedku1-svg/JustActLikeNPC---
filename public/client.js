// ============================================================
//  Act Like NPC - İstemci
// ============================================================
(() => {
  const NICK_MAX = 16;
  const NICK_KEY = 'alnpc_nick';
  const COLOR_KEY = 'alnpc_arrow_color';
  const HELP_KEY = 'alnpc_help_seen';

  const socket = io();

  // ---------- DURUM ----------
  const state = {
    nick: '',
    myId: null,
    room: null,          // Son oda anlık görüntüsü
    pendingCode: null,   // Davet linkinden gelen oda kodu
    screen: 'nick',
  };

  // ---------- ELEMANLAR ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    screens: {
      nick: $('screen-nick'),
      menu: $('screen-menu'),
      lobby: $('screen-lobby'),
      game: $('screen-game'),
    },
    nickForm: $('nick-form'),
    nickInput: $('nick-input'),
    nickCount: $('nick-count'),
    nickError: $('nick-error'),

    menuNick: $('menu-nick'),
    changeNick: $('change-nick'),
    btnCreate: $('btn-create'),
    joinForm: $('join-form'),
    codeInput: $('code-input'),
    menuError: $('menu-error'),
    menuInfo: $('menu-info'),

    lobbyCode: $('lobby-code'),
    btnCopyCode: $('btn-copy-code'),
    btnCopyLink: $('btn-copy-link'),
    copyFeedback: $('copy-feedback'),
    playerCount: $('player-count'),
    playerList: $('player-list'),
    colorOptions: $('color-options'),
    lobbyStatus: $('lobby-status'),
    btnReady: $('btn-ready'),
    btnLeave: $('btn-leave'),

    settingsLock: $('settings-lock'),
    roundsMinus: $('rounds-minus'),
    roundsPlus: $('rounds-plus'),
    roundsValue: $('rounds-value'),
    minutesOptions: $('minutes-options'),
    densityOptions: $('density-options'),
    npcEstimate: $('npc-estimate'),

    btnSound: $('btn-sound'),
    btnHelpMenu: $('btn-help-menu'),
    btnHelpLobby: $('btn-help-lobby'),
    helpModal: $('help-modal'),
    btnHelpClose: $('btn-help-close'),
    btnBackLobby: $('btn-back-lobby'),

    toast: $('toast'),
  };

  // ---------- NASIL OYNANIR / SES ----------
  function hasSeenHelp() {
    try { return localStorage.getItem(HELP_KEY) === '1'; } catch { return false; }
  }
  function markHelpSeen() {
    try { localStorage.setItem(HELP_KEY, '1'); } catch { /* yok say */ }
  }
  function openHelp() {
    el.helpModal.hidden = false;
  }
  function closeHelp() {
    el.helpModal.hidden = true;
    markHelpSeen();
  }

  // ---------- YARDIMCILAR ----------
  function showScreen(name) {
    state.screen = name;
    for (const [key, node] of Object.entries(el.screens)) {
      node.hidden = key !== name;
    }
    document.body.classList.toggle('in-game', name === 'game');
    // Oyun ekranından çıkınca çizim döngüsü durur
    if (name !== 'game') window.GameView.stop();
    if (name === 'lobby' && !hasSeenHelp()) {
      markHelpSeen();
      openHelp();
    }
    if (name === 'game' && !el.helpModal.hidden) closeHelp();
  }

  function showMessage(node, text) {
    node.textContent = text;
    node.hidden = !text;
  }

  let toastTimer = null;
  function toast(text, ms = 2500) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  function clearMenuMessages() {
    showMessage(el.menuError, '');
    showMessage(el.menuInfo, '');
  }

  function loadNick() {
    try { return localStorage.getItem(NICK_KEY) || ''; } catch { return ''; }
  }
  function saveNick(nick) {
    try { localStorage.setItem(NICK_KEY, nick); } catch { /* yok say */ }
  }
  function loadColor() {
    try { return localStorage.getItem(COLOR_KEY) || ''; } catch { return ''; }
  }
  function saveColor(colorId) {
    try { if (colorId) localStorage.setItem(COLOR_KEY, colorId); } catch { /* yok say */ }
  }

  function makeArrowSvg(hex) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '-8 -13 16 14');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M 0 0 L -7 -12 L 0 -9.2 L 7 -12 Z');
    path.setAttribute('fill', hex || '#e74c3c');
    path.setAttribute('stroke', '#140c08');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function inviteLink(code) {
    return `${location.origin}${location.pathname}?oda=${code}`;
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      showMessage(el.copyFeedback, okMsg);
    } catch {
      // Clipboard API yoksa (http üzerinden uzak erişim gibi) metni göster
      showMessage(el.copyFeedback, `Kopyalanamadı, elle kopyala: ${text}`);
    }
    setTimeout(() => showMessage(el.copyFeedback, ''), 2500);
  }

  function isLeader() {
    return state.room && state.room.leaderId === state.myId;
  }

  // ---------- EKRAN: TAKMA AD ----------
  el.nickInput.addEventListener('input', () => {
    el.nickCount.textContent = el.nickInput.value.length;
    showMessage(el.nickError, '');
  });

  el.nickForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const nick = el.nickInput.value.trim();
    if (!nick) return showMessage(el.nickError, 'Takma ad boş olamaz');
    if (nick.length > NICK_MAX) return showMessage(el.nickError, `En fazla ${NICK_MAX} karakter`);
    state.nick = nick;
    saveNick(nick);
    goToMenu();
    // Davet linkiyle geldiyse tek tıkla katılması için kod hazır bekler
  });

  function goToNickScreen() {
    el.nickInput.value = state.nick;
    el.nickCount.textContent = state.nick.length;
    showMessage(el.nickError, '');
    showScreen('nick');
    el.nickInput.focus();
  }

  // ---------- EKRAN: ANA MENÜ ----------
  function goToMenu() {
    el.menuNick.textContent = state.nick;
    clearMenuMessages();
    if (state.pendingCode) {
      el.codeInput.value = state.pendingCode;
      showMessage(el.menuInfo, `Davet aldın! "${state.pendingCode}" odasına katılmak için Bağlan'a bas.`);
    }
    showScreen('menu');
  }

  el.changeNick.addEventListener('click', (e) => {
    e.preventDefault();
    goToNickScreen();
  });

  el.btnCreate.addEventListener('click', () => {
    clearMenuMessages();
    el.btnCreate.disabled = true;
    socket.emit('room:create', { nick: state.nick, color: loadColor() }, (res) => {
      el.btnCreate.disabled = false;
      if (!res || !res.ok) showMessage(el.menuError, (res && res.error) || 'Oda kurulamadı');
    });
  });

  el.codeInput.addEventListener('input', () => {
    el.codeInput.value = el.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    showMessage(el.menuError, '');
  });

  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = el.codeInput.value.trim().toUpperCase();
    if (code.length !== 4) return showMessage(el.menuError, 'Oda kodu 4 karakter olmalı');
    joinRoom(code);
  });

  function joinRoom(code) {
    clearMenuMessages();
    socket.emit('room:join', { nick: state.nick, code, color: loadColor() }, (res) => {
      if (!res || !res.ok) {
        showMessage(el.menuError, (res && res.error) || 'Odaya katılınamadı');
        // Hatalı davet kodu bir daha otomatik denenmesin
        state.pendingCode = null;
        clearInviteFromUrl();
      }
    });
  }

  function clearInviteFromUrl() {
    if (location.search) {
      history.replaceState(null, '', location.pathname);
    }
  }

  // ---------- EKRAN: LOBİ ----------
  function renderLobby() {
    const room = state.room;
    if (!room) return;
    const me = room.players.find((p) => p.id === state.myId);
    const leader = isLeader();

    el.lobbyCode.textContent = room.code;
    el.playerCount.textContent = `${room.players.length}/10`;

    el.playerList.innerHTML = '';
    for (const p of room.players) {
      const li = document.createElement('li');
      if (p.id === state.myId) li.classList.add('me');

      const name = document.createElement('span');
      name.className = 'player-name';

      const arrowWrap = document.createElement('span');
      arrowWrap.className = 'player-arrow';
      arrowWrap.dataset.color = p.color || '';
      arrowWrap.append(makeArrowSvg(p.colorHex || '#e74c3c'));

      const nameText = document.createElement('span');
      nameText.textContent = (p.id === room.leaderId ? '👑 ' : '') + p.name + (p.id === state.myId ? ' (sen)' : '');
      name.append(arrowWrap, nameText);

      const status = document.createElement('span');
      status.className = 'player-status';
      status.textContent = p.ready ? '✅ hazır' : '⏳ bekliyor';

      li.append(name, status);

      if (leader && p.id !== state.myId) {
        const kick = document.createElement('button');
        kick.className = 'btn btn-kick';
        kick.textContent = 'At';
        kick.addEventListener('click', () => socket.emit('player:kick', { targetId: p.id }));
        li.append(kick);
      }
      el.playerList.append(li);
    }

    renderColorPicker(room, me);
    renderSettings();

    // Hazır butonu
    const ready = me ? me.ready : false;
    el.btnReady.textContent = ready ? '❌ Hazır değilim' : '✅ Hazırım';
    el.btnReady.classList.toggle('btn-ready-on', ready);

    // Durum metni
    const readyCount = room.players.filter((p) => p.ready).length;
    if (room.players.length < 2) {
      el.lobbyStatus.textContent = 'Başlamak için en az 2 oyuncu gerekli. Arkadaşlarını davet et!';
    } else if (readyCount < room.players.length) {
      el.lobbyStatus.textContent = `${readyCount}/${room.players.length} hazır. Herkes hazır olunca oyun otomatik başlar.`;
    } else {
      el.lobbyStatus.textContent = 'Herkes hazır, başlıyor...';
    }
  }

  // ---------- OK RENGİ SEÇİMİ ----------
  function renderColorPicker(room, me) {
    if (!el.colorOptions) return;
    const palette = room.arrowColors || [];
    const takenByOther = new Set(
      room.players.filter((p) => p.id !== state.myId && p.color).map((p) => p.color),
    );
    const myColor = me ? me.color : '';
    const key = `${palette.map((c) => c.id).join(',')}|${myColor}|${[...takenByOther].sort().join(',')}`;
    if (el.colorOptions.dataset.key === key) return;
    el.colorOptions.dataset.key = key;
    el.colorOptions.innerHTML = '';

    for (const c of palette) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'color-swatch';
      btn.dataset.color = c.id;
      const isMine = myColor === c.id;
      const isTaken = takenByOther.has(c.id);
      if (isMine) btn.classList.add('selected');
      if (isTaken) {
        btn.classList.add('taken');
        btn.disabled = true;
      }
      const lbl = document.createElement('span');
      lbl.className = 'color-swatch-label';
      lbl.textContent = c.label;
      btn.append(makeArrowSvg(c.hex), lbl);
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        saveColor(c.id);
        socket.emit('player:color', { color: c.id }, (res) => {
          if (res && res.ok) saveColor(res.color);
        });
      });
      el.colorOptions.append(btn);
    }
  }

  // ---------- OYUN AYARLARI (sadece lider değiştirir) ----------
  function renderSettings() {
    const room = state.room;
    if (!room || !room.settings) return;
    const s = room.settings;
    const lim = room.settingsLimits || { roundsMin: 1, roundsMax: 10, minuteOptions: [1, 2, 3, 4, 5] };
    const leader = isLeader();
    el.settingsLock.hidden = leader;
    el.roundsValue.textContent = s.rounds;
    el.roundsMinus.disabled = !leader || s.rounds <= lim.roundsMin;
    el.roundsPlus.disabled = !leader || s.rounds >= lim.roundsMax;

    const key = `${lim.minuteOptions.join(',')}|${s.roundMinutes}|${leader}`;
    if (el.minutesOptions.dataset.key !== key) {
      el.minutesOptions.dataset.key = key;
      el.minutesOptions.innerHTML = '';
      for (const m of lim.minuteOptions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `${m} dk`;
        b.classList.toggle('on', m === s.roundMinutes);
        b.disabled = !leader;
        b.addEventListener('click', () => sendSettings({ roundMinutes: m }));
        el.minutesOptions.append(b);
      }
    }

    // NPC yoğunluğu: Az / Normal / Çok
    const dens = lim.densityOptions || [];
    const dkey = `${dens.map((d) => d.id).join(',')}|${s.npcDensity}|${leader}`;
    if (el.densityOptions.dataset.key !== dkey) {
      el.densityOptions.dataset.key = dkey;
      el.densityOptions.innerHTML = '';
      for (const d of dens) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = d.label;
        b.dataset.id = d.id;
        b.classList.toggle('on', d.id === s.npcDensity);
        b.disabled = !leader;
        b.addEventListener('click', () => sendSettings({ npcDensity: d.id }));
        el.densityOptions.append(b);
      }
    }
    if (typeof room.npcEstimate === 'number') {
      el.npcEstimate.innerHTML = '';
      el.npcEstimate.append('👥 Bu ayarla yaklaşık ');
      const b = document.createElement('b');
      b.textContent = `${room.npcEstimate} NPC`;
      el.npcEstimate.append(b, ' olacak');
    }
  }

  const densityLabel = (room, id) => {
    const d = ((room.settingsLimits && room.settingsLimits.densityOptions) || []).find((x) => x.id === id);
    return d ? d.label : id;
  };

  function sendSettings(patch) {
    if (!isLeader()) return;
    socket.emit('room:settings', patch);
  }

  el.roundsMinus.addEventListener('click', () => {
    if (state.room) sendSettings({ rounds: state.room.settings.rounds - 1 });
  });
  el.roundsPlus.addEventListener('click', () => {
    if (state.room) sendSettings({ rounds: state.room.settings.rounds + 1 });
  });

  el.btnReady.addEventListener('click', () => socket.emit('player:toggleReady'));
  el.btnLeave.addEventListener('click', () => socket.emit('room:leave'));
  el.btnCopyCode.addEventListener('click', () => {
    if (state.room) copyText(state.room.code, 'Kod kopyalandı!');
  });
  el.btnCopyLink.addEventListener('click', () => {
    if (state.room) copyText(inviteLink(state.room.code), 'Davet linki kopyalandı!');
  });

  el.btnHelpMenu.addEventListener('click', openHelp);
  el.btnHelpLobby.addEventListener('click', openHelp);
  el.btnHelpClose.addEventListener('click', closeHelp);
  if (el.btnBackLobby) {
    el.btnBackLobby.addEventListener('click', () => {
      socket.emit('match:returnLobby');
      renderLobby();
      showScreen('lobby');
    });
  }
  el.helpModal.addEventListener('click', (e) => {
    if (e.target === el.helpModal) closeHelp();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.helpModal.hidden) closeHelp();
  });

  // ---------- EKRAN: OYUN ----------
  // Çizim ve oyun içi olaylar public/game.js (GameView) içinde.
  function renderGame() {
    // Oyun içi arayüzün tamamı GameView tarafından yönetilir
  }

  // ---------- SOCKET OLAYLARI ----------
  socket.on('connect', () => {
    state.myId = socket.id;
  });

  socket.on('room:joined', (room) => {
    state.myId = room.you;
    state.room = room;
    state.pendingCode = null;
    clearInviteFromUrl();
    el.codeInput.value = '';
    if (room.yourColor && !loadColor()) saveColor(room.yourColor);
    if (room.yourName !== state.nick) {
      toast(`Bu ad kullanılıyordu, adın "${room.yourName}" oldu`);
    }
    renderLobby();
    showScreen(room.state === 'playing' ? 'game' : 'lobby');
  });

  socket.on('room:update', (room) => {
    const prev = state.room && state.room.settings;
    const next = room.settings;
    // Lider ayarı değiştirdiyse diğer oyunculara kısa bilgi (hazırlıklar sıfırlandı)
    if (prev && next && state.screen === 'lobby' && room.leaderId !== state.myId &&
        (prev.rounds !== next.rounds || prev.roundMinutes !== next.roundMinutes || prev.npcDensity !== next.npcDensity)) {
      toast(`Lider ayarları değiştirdi: ${next.rounds} tur · ${next.roundMinutes} dk · NPC: ${densityLabel(room, next.npcDensity)}. Hazırlıklar sıfırlandı.`);
    }
    state.room = room;
    if (state.screen === 'lobby') renderLobby();
    if (state.screen === 'game') renderGame();
  });

  socket.on('room:left', ({ reason }) => {
    state.room = null;
    goToMenu();
    if (reason === 'kicked') showMessage(el.menuError, 'Lobiden atıldın');
  });

  socket.on('game:started', (room) => {
    state.room = room;
    renderGame();
    showScreen('game');
  });

  // Oyuna özel başlangıç verisi (harita, rol, kendi karakter ID'si)
  socket.on('game:init', (data) => {
    if (state.screen !== 'game') {
      renderGame();
      showScreen('game');
    }
    window.GameView.start(data, state.myId);
  });

  // Tur sonu (7 sn) ve final (10 sn) ekranları
  socket.on('round:end', (data) => window.GameView.showRoundEnd(data));
  socket.on('match:end', (data) => window.GameView.showFinal(data));

  socket.on('game:ended', (room) => {
    const wasInGame = state.screen === 'game';
    state.room = room;
    renderLobby();
    showScreen('lobby');
    if (wasInGame) {
      toast(room.reason ? `${room.reason}. Lobiye dönüldü` : 'Oyun bitti, lobiye dönüldü');
    }
  });

  socket.on('disconnect', () => {
    if (state.room) {
      state.room = null;
      goToMenu();
      showMessage(el.menuError, 'Sunucuyla bağlantı koptu');
    }
  });

  // ---------- BAŞLANGIÇ ----------
  function init() {
    if (window.SoundFX) window.SoundFX.init(el.btnSound);
    window.GameView.init(socket);
    const params = new URLSearchParams(location.search);
    const invite = (params.get('oda') || '').trim().toUpperCase();
    if (invite) state.pendingCode = invite;

    state.nick = loadNick();
    el.nickInput.value = state.nick;
    el.nickCount.textContent = state.nick.length;

    if (state.nick && state.pendingCode) {
      // Kayıtlı takma adı var ve davet linkiyle geldi: doğrudan odaya bağlan
      goToMenu();
      const code = state.pendingCode;
      const tryJoin = () => joinRoom(code);
      if (socket.connected) tryJoin();
      else socket.once('connect', tryJoin);
    } else if (state.nick) {
      goToMenu();
    } else {
      goToNickScreen();
    }
  }

  init();
})();
