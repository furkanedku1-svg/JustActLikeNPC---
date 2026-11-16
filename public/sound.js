// ============================================================
//  Act Like NPC - Web Audio API ses sentezleyici
//  Hiçbir harici ses dosyası kullanmaz; tüm sesler kodda üretilir.
// ============================================================
window.SoundFX = (() => {
  const MUTE_KEY = 'alnpc_muted';
  let ctx = null;
  let noiseBuf = null;
  let muted = false;
  let tickFlip = false;
  let btn = null;

  function loadMute() {
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
  }
  function saveMute(v) {
    try { localStorage.setItem(MUTE_KEY, v ? '1' : '0'); } catch { /* yok say */ }
  }

  function ensureCtx() {
    if (muted) return null;
    // Kullanıcı sayfayla hiç etkileşmediyse (ör. davet linkiyle otomatik katılım) ses sistemi
    // başlatılmaz; aksi halde tarayıcı konsola "AudioContext was not allowed to start" uyarısı yazar.
    const ua = navigator.userActivation;
    if (ua && !ua.hasBeenActive) return null;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      noiseBuf = buildNoise(ctx);
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function unlock() {
    if (muted) return;
    ensureCtx();
  }

  function buildNoise(ac) {
    const len = ac.sampleRate;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function tone(ac, type, f0, f1, dur, vol = 0.14, delay = 0) {
    const t = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 && f1 !== f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    }
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise(ac, dur, vol = 0.14, filterType = 'lowpass', f0 = 1200, f1 = 300, delay = 0) {
    if (!noiseBuf) return;
    const t = ac.currentTime + delay;
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    const flt = ac.createBiquadFilter();
    flt.type = filterType;
    flt.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt);
    flt.connect(gain);
    gain.connect(ac.destination);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  const EFFECTS = {
    // 1. Ateş etme
    shoot(ac) {
      noise(ac, 0.11, 0.18, 'bandpass', 1800, 320);
      tone(ac, 'triangle', 420, 95, 0.12, 0.16);
    },
    // 2. Masum NPC vurulunca kötü ses
    npcHit(ac) {
      tone(ac, 'sawtooth', 230, 140, 0.16, 0.11, 0);
      tone(ac, 'sawtooth', 165, 92, 0.28, 0.12, 0.14);
    },
    // 3. Oyuncu yakalandığında
    caught(ac) {
      tone(ac, 'square', 330, 440, 0.11, 0.09, 0);
      tone(ac, 'triangle', 523, 784, 0.22, 0.15, 0.09);
    },
    // 4. Elmas alma: parlak bir "ding"
    diamond(ac) {
      tone(ac, 'sine', 1046.5, 1046.5, 0.18, 0.16, 0);
      tone(ac, 'sine', 1567.98, 1567.98, 0.3, 0.15, 0.07);
    },
    // 5. Heykel inceleme
    statue(ac) {
      tone(ac, 'triangle', 392, 392, 0.18, 0.13, 0);
      tone(ac, 'sine', 587.3, 587.3, 0.22, 0.12, 0.08);
      tone(ac, 'sine', 784, 784, 0.28, 0.12, 0.16);
    },
    // 6. VIP öldürme
    vipKill(ac) {
      noise(ac, 0.08, 0.14, 'highpass', 900, 350);
      tone(ac, 'sawtooth', 520, 130, 0.16, 0.11, 0);
      tone(ac, 'triangle', 660, 880, 0.2, 0.12, 0.12);
    },
    // 6b. VIP'ye yumruk (kısa, tok darbe)
    punch(ac) {
      noise(ac, 0.07, 0.2, 'lowpass', 900, 200);
      tone(ac, 'triangle', 180, 70, 0.1, 0.16);
    },
    // 7. Bildirim
    notify(ac) {
      tone(ac, 'sine', 620, 740, 0.1, 0.1, 0);
      tone(ac, 'sine', 820, 820, 0.12, 0.08, 0.07);
    },
    // 8. Sis
    smoke(ac) {
      noise(ac, 0.55, 0.18, 'bandpass', 1400, 420, 0);
      tone(ac, 'sine', 240, 140, 0.25, 0.06, 0);
    },
    // 9. Radar Bombası (sonar ping)
    radar(ac) {
      tone(ac, 'sine', 880, 1320, 0.14, 0.14, 0);
      tone(ac, 'sine', 1320, 1320, 0.22, 0.12, 0.12);
    },
    // 10. Tur başlangıcı
    roundStart(ac) {
      tone(ac, 'triangle', 523.25, 523.25, 0.13, 0.13, 0);
      tone(ac, 'triangle', 659.25, 659.25, 0.13, 0.13, 0.1);
      tone(ac, 'triangle', 783.99, 783.99, 0.24, 0.15, 0.2);
    },
    // 11. Son 10 saniye tik-tak
    tick(ac) {
      tickFlip = !tickFlip;
      const freq = tickFlip ? 1020 : 780;
      tone(ac, 'square', freq, freq * 0.85, 0.045, 0.07, 0);
    },
    // 12. Final ekranı
    final(ac) {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => tone(ac, 'triangle', f, f, i === 3 ? 0.42 : 0.14, 0.14, i * 0.11));
    },
  };

  function play(name) {
    if (muted) return;
    const fn = EFFECTS[name];
    if (!fn) return;
    const ac = ensureCtx();
    if (!ac) return;
    try { fn(ac); } catch { /* tarayıcı kısıtlamasını yok say */ }
  }

  function updateButton() {
    if (!btn) return;
    btn.textContent = muted ? '🔇' : '🔊';
    btn.title = muted ? 'Sesi aç' : 'Sesi kapat';
    btn.setAttribute('aria-label', btn.title);
    btn.classList.toggle('muted', muted);
  }

  function toggleMute() {
    muted = !muted;
    saveMute(muted);
    updateButton();
    if (!muted) {
      ensureCtx();
      play('notify');
    }
  }

  function init(buttonEl) {
    muted = loadMute();
    btn = buttonEl;
    updateButton();
    if (btn) btn.addEventListener('click', toggleMute);

    // Tarayıcılar ses sistemini ilk kullanıcı etkileşiminde başlatır
    const onFirstGesture = () => {
      unlock();
      window.removeEventListener('pointerdown', onFirstGesture);
      window.removeEventListener('keydown', onFirstGesture);
    };
    window.addEventListener('pointerdown', onFirstGesture, { passive: true });
    window.addEventListener('keydown', onFirstGesture, { passive: true });
  }

  return { init, play, unlock, isMuted: () => muted };
})();
