/* ============================================
   Nova Timer - Application Logic
   ============================================ */

(() => {
  'use strict';

  // ----- Constants -----
  const RING_CIRCUMFERENCE = 2 * Math.PI * 135; // r=135 -> ~848.23
  const MAX_TIMERS = 5;
  const STORAGE_KEY = 'nova-timer-state-v1';
  const PREFS_KEY = 'nova-timer-prefs-v1';

  // ----- DOM refs -----
  const $ = (id) => document.getElementById(id);

  const els = {
    body: document.body,
    hoursInput: $('hoursInput'),
    minutesInput: $('minutesInput'),
    secondsInput: $('secondsInput'),
    statusPill: $('statusPill'),
    statusText: document.querySelector('.status-text'),
    startBtn: $('startBtn'),
    resetBtn: $('resetBtn'),
    lapBtn: $('lapBtn'),
    addTimerBtn: $('addTimerBtn'),
    themeBtn: $('themeBtn'),
    timerModeBtn: $('timerModeBtn'),
    stopwatchModeBtn: $('stopwatchModeBtn'),
    timerTabs: $('timerTabs'),
    timerDisplay: $('timerDisplay'),
    ringProgress: document.querySelector('.ring-progress'),
    tickMarks: $('tickMarks'),
    presets: $('presets'),
    lapsSection: $('lapsSection'),
    lapsList: $('lapsList'),
    clearLapsBtn: $('clearLapsBtn'),
    notification: $('notification'),
    notificationClose: $('notificationClose'),
    startBtnLabel: document.querySelector('#startBtn .btn-label'),
  };

  // ----- Generate tick marks around the ring -----
  function renderTicks() {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 60; i++) {
      const tick = document.createElement('div');
      tick.className = 'tick' + (i % 5 === 0 ? ' major' : '');
      tick.style.transform = `translate(-50%, -50%) rotate(${i * 6}deg) translateY(-152px)`;
      frag.appendChild(tick);
    }
    els.tickMarks.appendChild(frag);
  }
  renderTicks();

  // Set initial ring dasharray
  els.ringProgress.style.strokeDasharray = RING_CIRCUMFERENCE;
  els.ringProgress.style.strokeDashoffset = 0;

  // ============================================
  // Timer model
  // ============================================
  class Timer {
    constructor({ id, name, hours = 0, minutes = 5, seconds = 0, type = 'timer' } = {}) {
      this.id = id || `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      this.name = name || 'Timer';
      this.type = type; // 'timer' | 'stopwatch'
      this.setHours = hours;
      this.setMinutes = minutes;
      this.setSeconds = seconds;
      this.totalMs = this.computeTotalMs();
      this.remainingMs = this.totalMs;
      this.elapsedMs = 0; // stopwatch accumulated time
      this.state = 'idle'; // idle | running | paused | finished
      this.startedAt = null;
      this.laps = [];
      this._tickHandle = null;
    }

    computeTotalMs() {
      return ((this.setHours * 3600) + (this.setMinutes * 60) + this.setSeconds) * 1000;
    }

    setDuration(h, m, s) {
      if (this.type === 'stopwatch') return;
      this.setHours = h;
      this.setMinutes = m;
      this.setSeconds = s;
      this.totalMs = this.computeTotalMs();
      if (this.state === 'idle') this.remainingMs = this.totalMs;
    }

    start() {
      if (this.state === 'running') return false;
      if (this.type === 'timer') {
        if (this.totalMs <= 0) return false;
        if (this.state === 'finished' || this.remainingMs <= 0) {
          this.remainingMs = this.totalMs;
        }
      }
      if (this.type === 'stopwatch' && this.state === 'idle') {
        this.elapsedMs = 0;
      }
      this.startedAt = performance.now();
      this.state = 'running';
      return true;
    }

    pause() {
      if (this.state !== 'running') return;
      if (this.type === 'stopwatch') {
        this.elapsedMs += (performance.now() - this.startedAt);
      } else {
        const elapsed = performance.now() - this.startedAt;
        this.remainingMs = Math.max(0, this.remainingMs - elapsed);
      }
      this.state = 'paused';
    }

    reset() {
      this.state = 'idle';
      if (this.type === 'stopwatch') {
        this.elapsedMs = 0;
      } else {
        this.remainingMs = this.totalMs;
      }
      this.startedAt = null;
      this.laps = [];
    }

    getRemaining(now = performance.now()) {
      if (this.type === 'stopwatch') return 0;
      if (this.state === 'running' && this.startedAt != null) {
        return Math.max(0, this.remainingMs - (now - this.startedAt));
      }
      return this.remainingMs;
    }

    getElapsed(now = performance.now()) {
      if (this.type === 'stopwatch') {
        if (this.state === 'running' && this.startedAt != null) {
          return this.elapsedMs + (now - this.startedAt);
        }
        return this.elapsedMs;
      }
      return this.totalMs - this.getRemaining(now);
    }

    finish() {
      if (this.type === 'stopwatch') return; // stopwatch never finishes
      this.state = 'finished';
      this.remainingMs = 0;
    }

    addLap() {
      if (this.state !== 'running') return null;
      const elapsed = this.type === 'stopwatch'
        ? this.getElapsed()
        : this.totalMs - this.getRemaining();
      const prevElapsed = this.laps.length ? this.laps[this.laps.length - 1].elapsedMs : 0;
      const lap = {
        index: this.laps.length + 1,
        elapsedMs: elapsed,
        deltaMs: elapsed - prevElapsed,
      };
      this.laps.push(lap);
      return lap;
    }

    serialize() {
      return {
        id: this.id,
        name: this.name,
        type: this.type,
        setHours: this.setHours,
        setMinutes: this.setMinutes,
        setSeconds: this.setSeconds,
      };
    }
  }

  // ============================================
  // App state
  // ============================================
  const state = {
    timers: [],
    activeId: null,
    rafId: null,
    finishTimeout: null,
    theme: 'night',   // 'night' | 'morning'
    mode: 'timer',    // 'timer' | 'stopwatch'
  };

  // ============================================
  // Persistence
  // ============================================
  function saveState() {
    try {
      const payload = {
        timers: state.timers.map(t => t.serialize()),
        activeId: state.activeId,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) { /* ignore */ }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function savePreferences() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        theme: state.theme,
        mode: state.mode,
      }));
    } catch (e) { /* ignore */ }
  }

  function loadPreferences() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw);
      if (prefs.theme === 'morning' || prefs.theme === 'night') state.theme = prefs.theme;
      if (prefs.mode === 'timer' || prefs.mode === 'stopwatch') state.mode = prefs.mode;
    } catch (e) { /* ignore */ }
  }

  // ============================================
  // Formatting helpers
  // ============================================
  const pad2 = (n) => String(Math.floor(n)).padStart(2, '0');

  function msToParts(ms) {
    // Round up so countdown shows whole seconds nicely
    const totalSec = Math.ceil(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return { h, m, s };
  }

  function msToPartsFloor(ms) {
    // For stopwatch: floor so it counts up naturally
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return { h, m, s };
  }

  function formatLap(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const cs = Math.floor((ms % 1000) / 10);
    if (h > 0) return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
    return `${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
  }

  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  // ============================================
  // Active timer getter
  // ============================================
  function getActive() {
    return state.timers.find(t => t.id === state.activeId) || null;
  }

  // ============================================
  // Theme & Mode
  // ============================================
  function applyTheme() {
    const isMorning = state.theme === 'morning';
    els.body.classList.toggle('theme-morning', isMorning);

    // Update SVG ring gradient colors
    const stops = document.querySelectorAll('#ringGradient stop');
    if (isMorning) {
      if (stops[0]) stops[0].setAttribute('stop-color', '#ea580c');
      if (stops[1]) stops[1].setAttribute('stop-color', '#b45309');
      if (stops[2]) stops[2].setAttribute('stop-color', '#d97706');
    } else {
      if (stops[0]) stops[0].setAttribute('stop-color', '#a855f7');
      if (stops[1]) stops[1].setAttribute('stop-color', '#6366f1');
      if (stops[2]) stops[2].setAttribute('stop-color', '#06b6d4');
    }

    els.themeBtn.querySelector('.icon-moon').style.display = isMorning ? 'none' : '';
    els.themeBtn.querySelector('.icon-sun').style.display = isMorning ? '' : 'none';
    els.themeBtn.title = isMorning ? 'Switch to Night' : 'Switch to Morning';
  }

  function applyMode() {
    const isStopwatch = state.mode === 'stopwatch';
    els.timerModeBtn.classList.toggle('active', !isStopwatch);
    els.stopwatchModeBtn.classList.toggle('active', isStopwatch);
  }

  function toggleTheme() {
    state.theme = state.theme === 'night' ? 'morning' : 'night';
    applyTheme();
    savePreferences();
  }

  function switchMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    applyMode();

    hideNotification();
    clearTimeout(state.finishTimeout);
    els.body.classList.remove('is-running', 'is-paused', 'is-finishing');

    const isStopwatch = mode === 'stopwatch';
    const fresh = new Timer({
      type: isStopwatch ? 'stopwatch' : 'timer',
      minutes: isStopwatch ? 0 : 5,
    });
    state.timers = [fresh];
    state.activeId = fresh.id;

    renderAll();
    saveState();
    savePreferences();
  }

  // ============================================
  // Vibration helper
  // ============================================
  function vibrate(pattern) {
    if ('vibrate' in navigator) {
      try { navigator.vibrate(pattern); } catch (e) {}
    }
  }

  // ============================================
  // Render functions
  // ============================================
  function renderTimeDisplay(timer) {
    if (!timer) return;

    let h, m, s, progress;

    if (timer.type === 'stopwatch') {
      const elapsed = timer.getElapsed();
      const parts = msToPartsFloor(elapsed);
      h = parts.h; m = parts.m; s = parts.s;
      // Ring fills one full cycle per 60 seconds
      progress = timer.state === 'idle' ? 0 : (elapsed % 60000) / 60000;
    } else {
      const ms = timer.getRemaining();
      const parts = msToParts(ms);
      h = parts.h; m = parts.m; s = parts.s;
      progress = timer.totalMs > 0 ? ms / timer.totalMs : 0;
    }

    const focused = document.activeElement;
    if (focused !== els.hoursInput) els.hoursInput.value = pad2(h);
    if (focused !== els.minutesInput) els.minutesInput.value = pad2(m);
    if (focused !== els.secondsInput) els.secondsInput.value = pad2(s);

    els.hoursInput.classList.toggle('is-zero', h === 0);

    const offset = RING_CIRCUMFERENCE * (1 - progress);
    els.ringProgress.style.strokeDashoffset = offset;

    if (timer.state === 'running') {
      document.title = `${pad2(h)}:${pad2(m)}:${pad2(s)} • Nova Timer`;
    } else {
      document.title = 'Nova Timer';
    }
  }

  function renderStatus(timer) {
    if (!timer) return;
    els.body.classList.remove('is-running', 'is-paused', 'is-finishing');
    let label = 'Ready';
    if (timer.state === 'running') {
      els.body.classList.add('is-running');
      label = timer.type === 'stopwatch' ? 'Counting' : 'Running';
    } else if (timer.state === 'paused') {
      els.body.classList.add('is-paused');
      label = 'Paused';
    } else if (timer.state === 'finished') {
      els.body.classList.add('is-finishing');
      label = "Time's Up";
    }
    els.statusText.textContent = label;

    els.startBtnLabel.textContent = timer.state === 'running' ? 'Pause'
      : timer.state === 'paused' ? 'Resume'
      : timer.state === 'finished' ? 'Restart'
      : 'Start';

    els.lapBtn.disabled = timer.state !== 'running';

    // Inputs editable only in timer mode when idle
    const editable = timer.type === 'timer' && timer.state === 'idle';
    [els.hoursInput, els.minutesInput, els.secondsInput].forEach(inp => {
      inp.readOnly = !editable;
      inp.style.cursor = editable ? 'text' : 'default';
    });
  }

  function renderTabs() {
    els.timerTabs.innerHTML = '';
    if (state.timers.length <= 1) {
      els.timerTabs.style.display = 'none';
      return;
    }
    els.timerTabs.style.display = 'flex';

    state.timers.forEach((timer, idx) => {
      const timerId = timer.id;

      const tab = document.createElement('div');
      tab.className = 'timer-tab';
      tab.dataset.id = timerId;
      if (timerId === state.activeId) tab.classList.add('active');
      if (timer.state === 'running') tab.classList.add('is-running');

      tab.addEventListener('click', () => selectTimer(timerId));

      const dot = document.createElement('span');
      dot.className = 'tab-indicator';
      tab.appendChild(dot);

      const label = document.createElement('span');
      label.textContent = timer.type === 'stopwatch' ? `Watch ${idx + 1}` : `Timer ${idx + 1}`;
      tab.appendChild(label);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'tab-close';
      closeBtn.setAttribute('aria-label', 'Remove');
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTimer(timerId);
      });
      tab.appendChild(closeBtn);

      els.timerTabs.appendChild(tab);
    });
  }

  function renderLaps(timer) {
    if (!timer || timer.laps.length === 0) {
      els.lapsSection.hidden = true;
      return;
    }
    els.lapsSection.hidden = false;
    els.lapsList.innerHTML = '';
    [...timer.laps].reverse().forEach(lap => {
      const row = document.createElement('div');
      row.className = 'lap-item';
      row.innerHTML = `
        <span class="lap-number">#${pad2(lap.index)}</span>
        <span class="lap-time">${formatLap(lap.elapsedMs)}</span>
        <span class="lap-delta">+${formatLap(lap.deltaMs)}</span>
      `;
      els.lapsList.appendChild(row);
    });
  }

  function renderAll() {
    const timer = getActive();
    if (!timer) return;
    renderTimeDisplay(timer);
    renderStatus(timer);
    renderTabs();
    renderLaps(timer);
    // Presets only in timer mode
    els.presets.style.display = state.mode === 'stopwatch' ? 'none' : '';
  }

  // ============================================
  // Animation loop
  // ============================================
  function startRafLoop() {
    if (state.rafId) return;
    const loop = () => {
      const timer = getActive();
      if (timer && timer.state === 'running') {
        renderTimeDisplay(timer);
        // Only countdown timers can finish
        if (timer.type === 'timer' && timer.getRemaining() <= 0) {
          handleFinish(timer);
        }
      }
      state.rafId = requestAnimationFrame(loop);
    };
    state.rafId = requestAnimationFrame(loop);
  }

  startRafLoop();

  // ============================================
  // Notification
  // ============================================
  function showNotification() {
    els.notification.classList.add('show');
  }

  function hideNotification() {
    els.notification.classList.remove('show');
  }

  function requestBrowserNotification() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }

  function sendBrowserNotification(timer) {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification('Nova Timer', {
          body: `${timer.name} has finished!`,
          icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23a855f7"><circle cx="12" cy="13" r="9"/></svg>',
        });
      } catch (e) {}
    }
  }

  // ============================================
  // Timer actions
  // ============================================
  function readInputDuration() {
    const h = clamp(parseInt(els.hoursInput.value, 10) || 0, 0, 99);
    const m = clamp(parseInt(els.minutesInput.value, 10) || 0, 0, 59);
    const s = clamp(parseInt(els.secondsInput.value, 10) || 0, 0, 59);
    return { h, m, s };
  }

  function startOrPause() {
    const timer = getActive();
    if (!timer) return;

    if (timer.state === 'finished') {
      // Restart
      hideNotification();
      clearTimeout(state.finishTimeout);
      timer.reset();
      timer.start();
      renderAll();
      saveState();
      return;
    }

    if (timer.state === 'running') {
      timer.pause();
      renderAll();
      saveState();
      return;
    }

    // idle or paused -> start/resume
    if (timer.state === 'idle' && timer.type === 'timer') {
      const { h, m, s } = readInputDuration();
      timer.setDuration(h, m, s);
    }
    const ok = timer.start();
    if (!ok) {
      if (timer.type === 'timer') {
        [els.hoursInput, els.minutesInput, els.secondsInput].forEach(inp => {
          inp.animate(
            [{ color: 'var(--danger)' }, { color: '' }],
            { duration: 600 }
          );
        });
      }
      return;
    }
    if (timer.type === 'timer') requestBrowserNotification();
    renderAll();
    saveState();
  }

  function resetActive() {
    const timer = getActive();
    if (!timer) return;
    clearTimeout(state.finishTimeout);
    hideNotification();
    vibrate(0);
    timer.reset();
    renderAll();
    saveState();
  }

  function lapActive() {
    const timer = getActive();
    if (!timer) return;
    const lap = timer.addLap();
    if (lap) renderLaps(timer);
  }

  function handleFinish(timer) {
    if (timer.state === 'finished') return;
    timer.finish();
    renderAll();
    showNotification();
    sendBrowserNotification(timer);
    vibrate([200, 100, 200, 100, 400]);
    // Auto-hide notification after 30s
    clearTimeout(state.finishTimeout);
    state.finishTimeout = setTimeout(() => {
      hideNotification();
      vibrate(0);
    }, 30000);
  }

  // ============================================
  // Multi-timer management
  // ============================================
  function addTimer() {
    if (state.timers.length >= MAX_TIMERS) {
      flashAddButton();
      return;
    }
    const isStopwatch = state.mode === 'stopwatch';
    const timer = new Timer({
      type: isStopwatch ? 'stopwatch' : 'timer',
      minutes: isStopwatch ? 0 : 5,
    });
    state.timers.push(timer);
    state.activeId = timer.id;
    renderAll();
    saveState();
  }

  function removeTimer(id) {
    const idx = state.timers.findIndex(t => t.id === id);
    if (idx === -1 || state.timers.length <= 1) return;
    const wasActive = state.activeId === id;
    state.timers.splice(idx, 1);
    if (wasActive) {
      state.activeId = state.timers[Math.max(0, idx - 1)].id;
    }
    renderAll();
    saveState();
  }

  function selectTimer(id) {
    if (state.activeId === id) return;
    state.activeId = id;
    renderAll();
    saveState();
  }

  function flashAddButton() {
    els.addTimerBtn.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(0.85)' }, { transform: 'scale(1)' }],
      { duration: 300, easing: 'ease-out' }
    );
  }

  // ============================================
  // Input handling
  // ============================================
  function sanitizeInput(input, max) {
    let v = input.value.replace(/[^\d]/g, '');
    if (v.length > 2) v = v.slice(0, 2);
    const n = parseInt(v, 10);
    if (!isNaN(n) && n > max) v = String(max);
    input.value = v;
  }

  function commitInputValue(input, max) {
    let n = parseInt(input.value, 10);
    if (isNaN(n) || n < 0) n = 0;
    if (n > max) n = max;
    input.value = pad2(n);

    const timer = getActive();
    if (timer && timer.state === 'idle') {
      const { h, m, s } = readInputDuration();
      timer.setDuration(h, m, s);
      renderTimeDisplay(timer);
    }
  }

  function setupInput(input, max, nextInput) {
    input.addEventListener('focus', () => {
      const timer = getActive();
      if (timer && timer.state !== 'idle') {
        input.blur();
        return;
      }
      setTimeout(() => input.select(), 0);
    });

    input.addEventListener('input', () => {
      sanitizeInput(input, max);
      if (input.value.length === 2 && nextInput) {
        nextInput.focus();
      }
    });

    input.addEventListener('blur', () => commitInputValue(input, max));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        input.blur();
        startOrPause();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const n = clamp((parseInt(input.value, 10) || 0) + 1, 0, max);
        input.value = pad2(n);
        commitInputValue(input, max);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const n = clamp((parseInt(input.value, 10) || 0) - 1, 0, max);
        input.value = pad2(n);
        commitInputValue(input, max);
      } else if (e.key === 'ArrowRight' && input.selectionStart === input.value.length && nextInput) {
        nextInput.focus();
      } else if (e.key === 'ArrowLeft' && input.selectionStart === 0) {
        e.preventDefault();
        const inputs = [els.hoursInput, els.minutesInput, els.secondsInput];
        const idx = inputs.indexOf(input);
        if (idx > 0) inputs[idx - 1].focus();
      }
    });
  }

  setupInput(els.hoursInput, 99, els.minutesInput);
  setupInput(els.minutesInput, 59, els.secondsInput);
  setupInput(els.secondsInput, 59, null);

  // ============================================
  // Preset chips
  // ============================================
  els.presets.addEventListener('click', (e) => {
    const chip = e.target.closest('.preset-chip');
    if (!chip) return;
    const totalSeconds = parseInt(chip.dataset.seconds, 10);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;

    const timer = getActive();
    if (!timer || timer.type === 'stopwatch') return;
    if (timer.state !== 'idle') {
      hideNotification();
      timer.reset();
    }
    timer.setDuration(h, m, s);
    renderAll();
    saveState();

    chip.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(0.92)' }, { transform: 'scale(1)' }],
      { duration: 250, easing: 'ease-out' }
    );
    if ('vibrate' in navigator) {
      try { navigator.vibrate(15); } catch (e) {}
    }
  });

  // ============================================
  // Button bindings
  // ============================================
  els.startBtn.addEventListener('click', startOrPause);
  els.resetBtn.addEventListener('click', resetActive);
  els.lapBtn.addEventListener('click', lapActive);
  els.addTimerBtn.addEventListener('click', addTimer);
  els.themeBtn.addEventListener('click', toggleTheme);
  els.timerModeBtn.addEventListener('click', () => switchMode('timer'));
  els.stopwatchModeBtn.addEventListener('click', () => switchMode('stopwatch'));
  els.notificationClose.addEventListener('click', hideNotification);
  els.clearLapsBtn.addEventListener('click', () => {
    const timer = getActive();
    if (!timer) return;
    timer.laps = [];
    renderLaps(timer);
  });

  // ============================================
  // Keyboard shortcuts
  // ============================================
  document.addEventListener('keydown', (e) => {
    // Block shortcuts only when user can actually type (editable input)
    if (e.target.tagName === 'INPUT' && !e.target.readOnly) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.code === 'Space') {
      e.preventDefault();
      startOrPause();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      resetActive();
    } else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      lapActive();
    } else if (e.key === 'Escape') {
      hideNotification();
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      addTimer();
    }
  });

  // ============================================
  // Init
  // ============================================
  function init() {
    loadPreferences();
    applyTheme();
    applyMode();

    const saved = loadState();
    if (saved && Array.isArray(saved.timers) && saved.timers.length > 0) {
      state.timers = saved.timers.map(data => new Timer({
        id: data.id,
        name: data.name,
        type: data.type || 'timer',
        hours: data.setHours,
        minutes: data.setMinutes,
        seconds: data.setSeconds,
      }));
      state.activeId = saved.activeId && state.timers.find(t => t.id === saved.activeId)
        ? saved.activeId
        : state.timers[0].id;
    } else {
      const isStopwatch = state.mode === 'stopwatch';
      const initial = new Timer({
        type: isStopwatch ? 'stopwatch' : 'timer',
        minutes: isStopwatch ? 0 : 5,
      });
      state.timers.push(initial);
      state.activeId = initial.id;
    }
    renderAll();
  }

  init();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) renderAll();
  });
})();
