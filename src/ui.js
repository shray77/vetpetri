/*
 * ВетПетри — интерфейс: рендер чаши (Canvas), инструменты, пресеты-эксперименты,
 * графики, панель параметров, интеграция тестов. Движок — отдельно (src/engine.js).
 */
(function () {
  'use strict';
  const E = window.VetPetriEngine, T = window.VetPetriTests;
  const $ = function (id) { return document.getElementById(id); };

  const W = 128, H = 80, DT = 0.02;
  const SUP = { '0': '\u2070', '1': '\u00b9', '2': '\u00b2', '3': '\u00b3', '4': '\u2074', '5': '\u2075', '6': '\u2076', '7': '\u2077', '8': '\u2078', '9': '\u2079', '-': '\u207b' };
  function sup(n) { return String(n).split('').map(function (c) { return SUP[c] || c; }).join(''); }
  function fmtExp(x) { // 1.2e9 → "1.2·10⁹"
    if (!(x > 0.999)) return '0';
    const e = Math.floor(Math.log10(x));
    const m = x / Math.pow(10, e);
    return (m >= 9.95 ? '10' : m.toFixed(1)) + '\u00b710' + sup(e);
  }

  const dish = $('dish'), dctx = dish.getContext('2d');
  const off = document.createElement('canvas'); off.width = W; off.height = H;
  const octx = off.getContext('2d');
  const img = octx.createImageData(W, H);

  let st = null, playing = false, speed = 8, tool = { kind: 'seed', sp: 0 };
  let history = [], lastPush = -1, frameNo = 0, curPreset = 0;
  let chron = [], chronFl = null, chronDirty = false; // хроника событий (v1.2)

  // ---------- параметры видов из UI ----------
  function uiSpecies() {
    const list = [];
    for (let i = 0; i < E.SPECIES.length; i++) {
      const sp = E.SPECIES[i];
      list.push(Object.assign({}, sp, {
        muMax: parseFloat($('sp-mu-' + i).value) || sp.muMax,
        MIC: parseFloat($('sp-mic-' + i).value) || sp.MIC,
        enabled: $('sp-en-' + i).checked,
      }));
    }
    return list;
  }

  function readUIEnv() {
    const half = Math.max(0, parseFloat($('kel').value) || 0);
    return {
      S0: Math.max(50, parseFloat($('S0').value) || 1000),
      kel: half > 0 ? Math.LN2 / half : 0,
      pMut: parseFloat($('pMut').value) || 0,
    };
  }

  // ---------- пресет «Мега-чаша»: полосы 0 → 1× → 10× → 100× MICwt (Baym 2016) ----------
  const MEGA_ZONES = [
    { f0: 0, f1: 0.25, mult: 0 }, { f0: 0.25, f1: 0.5, mult: 1 },
    { f0: 0.5, f1: 0.75, mult: 10 }, { f0: 0.75, f1: 1, mult: 100 },
  ];

  function buildState() {
    const species = uiSpecies();
    const enabled = species.map(function (s) { return s.enabled; });
    const s = E.createState({
      W: W, H: H, seed: (parseInt($('seed').value, 10) || 42) >>> 0,
      species: species, enabled: enabled, env: readUIEnv(),
      dosing: { mode: $('doseMode').value, dose: doseVal() },
      abZones: curPreset === 5 ? MEGA_ZONES : null,
    });
    return s;
  }

  // ---------- лекционные сценарии (Avida-ED style: предскажи → запусти → сравни) ----------
  const LECTURES = [
    { steps: ['Скорость 0.5 ч/с → «Пуск». Найди на графике три фазы: лаг (~2 ч), экспоненту (прямая в log₁₀), плато.',
      'На нижнем графике проследи, как тает субстрат — рост идёт, пока есть еда.',
      'После плато подними скорость до 20 ч/с и дождись отмирания.'],
      q: 'Почему кривая останавливается, хотя бактерии никуда не исчезают?',
      a: 'Ёмкость среды ограничена: плато ≈ Y·S₀. Кинетика Моно + логистика — как в учебнике.' },
    { steps: ['Пуск на 8 ч/с. Найди границу между колониями E. coli (голубая) и Salmonella (оранжевая).',
      'Открой «Виды», задай Salmonella μmax = 2.0, сбрось и запусти заново — исход сменится.',
      'Попробуй то же с другой S₀ (меньше еды — острее конкуренция).'],
      q: 'Кто выигрывает: тот, кто быстрее растёт, или тот, кто раньше истощает общий субстрат?',
      a: 'Это эксплуатационная конкуренция — родственник Лотки–Вольтерры с общим ресурсом.' },
    { steps: ['Суточная доза 32 мг/л, режим «1 болюс» → Пуск. Смотри фиолетовую кривую и бейдж T>MIC.',
      'Сброс, та же доза в режиме «инфузия 24 ч» → сравни T>MIC и форму кривой КОЕ.',
      'Повтори с «3 введения (q8h)» — три промежуточных пика.'],
      q: 'У какой кривой пик выше? А у какой время выше MIC больше? Какая стратегия «лечит» для β-лактама?',
      a: 'β-лактамы time-dependent: цель fT>MIC 40–70% (Berry 2022). Лечит не «сколько дали», а «сколько держали».' },
    { steps: ['Запусти дозу 0.5 мг/л (ниже MIC) — растут оба.',
      'Доза 8 мг/л (между MIC 4 и MPC 32) — wt подавлен, доля R → 100%.',
      'Доза 256 мг/л (выше MPC мутанта) — подавлены оба.'],
      q: 'Какая доза хуже всего для стада — низкая, средняя или очень высокая?',
      a: 'Окно селекции MIC…MPC (Drlica): «пол-таблетки» — самый дорогой способ сэкономить.' },
    { steps: ['Посей E. coli слева, Salmonella справа, поставь каплю АБ на границу (доза из слайдера).',
      'Включи мутации 10⁻⁶ и понаблюдай край капли.',
      'Ткни курсором в границу — подсказка покажет концентрацию и состав в точке.'],
      q: 'Почему на краю капли антибиотика выросло именно кольцо резистентных?',
      a: 'Градиент концентрации = живое окно селекции: где A между MIC и MPC — там мутант в преимуществе.' },
    { steps: ['Скорость 20 ч/с → Пуск. Розовый (R) фронт прорывает полосу 1×MIC.',
      'Затем он медленно ползёт через 10×MIC и стопорится на 100×MIC.',
      'Сравни с видео HHMI «Giant Petri Dish» (Kishony lab, Baym 2016).'],
      q: 'Почему мутант не берёт полосу 100× сразу, а «фиксируется» на каждой ступени?',
      a: 'Ступенчатая эволюция: каждая полоса — трамплин. Недодозированная среда строит лестницу резистентности.' },
  ];

  function lectureHTML(idx) {
    const L = LECTURES[idx];
    if (!L) return '';
    return '<details class="lecture"><summary>Сценарий для пары</summary><ol>' +
      L.steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>' +
      '<div class="lq"><b>Вопрос:</b> ' + L.q + '</div>' +
      '<div class="la"><b>Вывод:</b> ' + L.a + '</div></details>';
  }

  // ---------- пресеты-эксперименты ----------
  const PRESETS = [
    {
      name: 'Кривая роста',
      note: '<b>Кинетика Моно на одном виде.</b> Капля E. coli в чистой чаше: лаг-фаза (~2 ч, адаптация по Бараньи) → экспонента (удвоение ~20 мин) → плато (субстрат исчерпан, выход ≈ Y·S\u2080) → медленное отмирание. На нижнем графике зелёная кривая — субстрат тает по мере роста.',
      ui: function () {
        $('sp-en-0').checked = true; $('sp-en-1').checked = false; $('sp-en-2').checked = false; $('sp-en-3').checked = false;
        $('kel').value = 1.0; $('pMut').value = '0'; $('doseMode').value = 'bolus';
      },
      setup: function (s) {
        E.inoculate(s, 0, s.cx, s.cy, 1e6, 4);
      },
    },
    {
      name: 'Конкуренция видов',
      note: '<b>Два вида против общего субстрата</b> (эксплуатационная конкуренция, родственник Лотки–Вольтерры с общим ресурсом). E. coli (быстрорастущий) против Salmonella Dublin. Следи за границей колоний: кто первым захватывает субстрат, тот и давит соседа.',
      ui: function () {
        $('sp-en-0').checked = true; $('sp-en-1').checked = true; $('sp-en-2').checked = false; $('sp-en-3').checked = false;
        $('kel').value = 1.0; $('pMut').value = '0'; $('doseMode').value = 'bolus';
      },
      setup: function (s) {
        E.inoculate(s, 0, s.cx - s.R * 0.45, s.cy, 5e6, 4);
        E.inoculate(s, 1, s.cx + s.R * 0.45, s.cy, 5e6, 4);
      },
    },
    {
      name: 'Time-kill: режим введения',
      note: '<b>Фармакодинамика амоксициллина (Хилл/Emax) + dose fractionation.</b> Газон E. coli + суточная доза из слайдера, внесённая по выбранному режиму: «1 болюс» / «3 введения (q8h)» / «инфузия 24 ч». Кривая КОЕ: лог-линейный спад (kmax ≈ 3 ч⁻¹), потом регроу, когда концентрация (фиолетовая) падает ниже MIC. Бейдж T>MIC — доля первых суток выше MIC: для β-лактамов цель 40–70% (Berry 2022).',
      ui: function () {
        $('sp-en-0').checked = true; $('sp-en-1').checked = false; $('sp-en-2').checked = false; $('sp-en-3').checked = false;
        $('kel').value = 1.0; $('pMut').value = '0';
      },
      setup: function (s) {
        E.lawn(s, 0, 1e7);
        E.initDose(s); // болюс / первая из трёх / инфузия — по селектору режима
      },
    },
    {
      name: 'Окно селекции мутантов',
      note: '<b>Почему «средняя доза» растит резистентность (Drlica).</b> Газон E. coli + 1% мутанта (MIC 64, цена: рост −10%). Концентрация поддерживается (t½ → ∞, «инфузия»). Доза в окне селекции (MICwt = 4 … MPC = 32): wt подавлен, мутант растёт → доля R → 100%. Доза выше MPC мутанта (256): подавлены оба. Доза ниже MIC: растут оба. Верни t½ = 1 ч — увидишь, как болюс проходит через окно и wt отрастает.',
      ui: function () {
        $('sp-en-0').checked = true; $('sp-en-1').checked = false; $('sp-en-2').checked = false; $('sp-en-3').checked = true;
        $('kel').value = 0; $('pMut').value = '0'; $('doseMode').value = 'bolus';
      },
      setup: function (s) {
        E.lawn(s, 0, 1e7); E.lawn(s, 3, 1e5);
        E.bolusAB(s, 8); // внутри окна селекции
        setDoseSlider(8);
      },
    },
    {
      name: 'Песочница',
      note: '<b>Свободная игра.</b> Клик по инструменту «Посев» циклически меняет вид; капля антибиотика берёт дозу из слайдера — вокруг капли возникает градиент концентраций, и на границе «рост/гибель» можно ловить окно селекции вручную. Включи мутации 10\u207b\u2076 и понаблюдай. Курсор на чаше — подсказка «что под ним».',
      ui: function () {
        $('sp-en-0').checked = true; $('sp-en-1').checked = true; $('sp-en-2').checked = true; $('sp-en-3').checked = false;
        $('kel').value = 1.0; $('pMut').value = '1e-6'; $('doseMode').value = 'bolus';
      },
      setup: function (s) {},
    },
    {
      name: 'Мега-чаша: лестница доз',
      note: '<b>Эксперимент Kishony lab (Baym 2016, Science).</b> Чаша разделена на полосы антибиотика 0 → 1× → 10× → 100× MICwt. Газон E. coli по всей чаше + редкий R-клон (β-лактамаза, MIC 64) в нулевой зоне слева. wt упирается в полосу 1×MIC (net-рост = 0), мутант прорывает её, медленно идёт через 10× и стопорится на 100×. Каждая полоса — трамплин ступенчатой эволюции. Слайдер дозы здесь не действует — концентрации задают полосы.',
      ui: function () {
        $('sp-en-0').checked = true; $('sp-en-1').checked = false; $('sp-en-2').checked = false; $('sp-en-3').checked = true;
        $('kel').value = 1.0; $('pMut').value = '1e-6'; $('doseMode').value = 'bolus';
      },
      setup: function (s) {
        E.lawn(s, 0, 1e7);                                   // газон wt по всей чаше
        E.inoculate(s, 3, s.cx - s.R * 0.8, s.cy, 1e4, 2);   // R-клон в нулевой зоне
        $('selSpeed').value = '20'; speed = 20;
      },
    },
  ];

  // ---------- доза ----------
  function doseVal() { return Math.pow(10, parseInt($('dose').value, 10) / 100); }
  function setDoseSlider(v) { $('dose').value = Math.round(100 * Math.log10(Math.max(0.1, Math.min(256, v)))); updateDoseUI(); }
  function updateDoseUI() {
    const d = doseVal(), x = d / E.SPECIES[0].MIC;
    $('doseVal').textContent = (d >= 10 ? d.toFixed(0) : d.toFixed(1)) + ' мг/л';
    $('doseX').textContent = '= ' + (x >= 10 ? x.toFixed(0) : x.toFixed(1)) + '\u00d7MICwt';
  }

  // ---------- PK: бейдж T>MIC (доля первых суток выше MICwt, Berry 2022: цель 40–70%) ----------
  function updatePKBadge() {
    const el = $('pkBadge');
    if (!el) return;
    if (curPreset !== 2 || !st || !history.length) { el.style.display = 'none'; return; }
    const mic = st.species[0].MIC;
    let above = 0, n = 0;
    for (let k = 0; k < history.length; k++) {
      if (history[k].t > 24.001) continue; // первые сутки
      n++;
      if (history[k].A > mic) above++;
    }
    if (!n) { el.style.display = 'none'; return; }
    const f = above / n, modeName = $('doseMode').value;
    el.style.display = '';
    el.textContent = 'T>MIC (0–24 ч): ' + (f * 100).toFixed(0) + '% [' +
      (modeName === 'bolus' ? '1 болюс' : modeName === 'q8h' ? '3 введения' : 'инфузия') +
      '] · цель для β-лактамов 40–70%';
    el.className = 'pk-badge ' + (f >= 0.4 ? 'ok' : 'bad');
  }

  // ---------- сброс/пуск ----------
  function applyPreset(idx) {
    curPreset = idx;
    document.querySelectorAll('.pbtn').forEach(function (b) { b.classList.toggle('active', +b.dataset.p === idx); });
    $('presetNote').innerHTML = PRESETS[idx].note + lectureHTML(idx);
    if (PRESETS[idx].ui) PRESETS[idx].ui(); // сначала UI-поля, потом buildState их прочитает
    resetSim();
  }

  function resetSim() {
    st = buildState();
    PRESETS[curPreset].setup(st);
    history = []; lastPush = -1;
    chron = []; chronFl = E.chronFlags(); chronDirty = false;
    playing = false; $('btnPlay').textContent = '\u25b6 Пуск';
    for (let i = 0; i < 4; i++) { const row = $('sprow-' + i); if (row) row.classList.toggle('sp-off', !st.enabled[i]); }
    pushHistory(true);
    render();
    drawCharts();
    renderChron();
    updateLegend();
    updateClock();
    updatePKBadge();
  }

  function pushHistory(force) {
    if (!force && st.t - lastPush < 0.1) return;
    lastPush = st.t;
    const s = E.stats(st);
    history.push({ t: s.t, tot: s.totals.slice(), S: s.S, A: s.A });
    if (history.length > 2600) history = history.filter(function (_, i) { return i % 2 === 0; });
    const evs = E.chronicleStep(st, s, chronFl || (chronFl = E.chronFlags()));
    if (evs.length) pushChronEvents(evs);
  }

  // ---------- хроника событий (F8): автособытия + ручные действия ----------
  function pushChronEvents(evs) {
    for (let k = 0; k < evs.length; k++) chron.push(evs[k]);
    if (chron.length > 120) chron.splice(0, chron.length - 120);
    chronDirty = true;
  }
  function logEvent(txt, cls) { // ручные действия; анти-спам при протяжке
    if (!st) return;
    const last = chron[chron.length - 1];
    if (last && last.txt === txt && st.t - last.t < 1.5) return;
    chron.push({ t: st.t, txt: txt, cls: cls || 'man' });
    if (chron.length > 120) chron.splice(0, chron.length - 120);
    renderChron();
  }
  function renderChron() {
    const box = $('chronList');
    if (!box) return;
    let html = '';
    for (let k = chron.length - 1; k >= 0; k--) {
      const e = chron[k];
      html += '<div class="ev"><span class="dot ' + e.cls + '"></span>t=' + e.t.toFixed(1) + ' ч — ' + e.txt + '</div>';
    }
    box.innerHTML = html || '<div class="ev muted">пока тихо — события появятся по ходу прогона</div>';
    box.scrollTop = 0;
  }

  // ---------- рендер чаши ----------
  function render() {
    const d = img.data, S = st.S, A = st.A, N = st.N, S0 = st.env.S0;
    const spc = st.species, en = st.enabled, Nmax = st.env.Nmax;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, p = i * 4;
        if (!E.inside(st, x, y)) { d[p + 3] = 0; continue; }
        // агар: голодный тёмный → сытый зеленоватый
        const fed = Math.min(1, S[i] / S0);
        let r = 22 + fed * 14, g = 27 + fed * 26, b = 34 + fed * 10;
        // клетки: смесь цветов по долям, яркость по log плотности
        let ntot = 0, cr = 0, cg = 0, cb = 0;
        for (let s = 0; s < 4; s++) {
          if (!en[s]) continue;
          const n = N[s][i];
          if (n > 0) { ntot += n; const c = spc[s].color; cr += c[0] * n; cg += c[1] * n; cb += c[2] * n; }
        }
        if (ntot > 0.5) {
          const a = Math.min(1, Math.log10(1 + ntot) / 8.2);
          cr /= ntot; cg /= ntot; cb /= ntot;
          const k = a * 0.93;
          r = r * (1 - k) + cr * k; g = g * (1 - k) + cg * k; b = b * (1 - k) + cb * k;
          if (ntot > Nmax * 0.35) { r = Math.min(255, r * 1.14); g = Math.min(255, g * 1.14); b = Math.min(255, b * 1.14); }
        }
        // антибиотик: фиолетовый оверлей (насыщение по концентрации)
        const aA = A[i] / (A[i] + 6);
        if (aA > 0.004) {
          const k = aA * 0.55;
          r = r * (1 - k) + 142 * k; g = g * (1 - k) + 104 * k; b = b * (1 - k) + 255 * k;
        }
        d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    dctx.imageSmoothingEnabled = false;
    dctx.clearRect(0, 0, dish.width, dish.height);
    dctx.drawImage(off, 0, 0, dish.width, dish.height);
    // ободок чашки
    const cx = dish.width / 2, cy = dish.height / 2, R = st.R * (dish.width / W);
    dctx.lineWidth = 3; dctx.strokeStyle = '#2b3b55';
    dctx.beginPath(); dctx.arc(cx, cy, R + 2, 0, 6.2832); dctx.stroke();
    dctx.lineWidth = 1; dctx.strokeStyle = 'rgba(140,170,220,.25)';
    dctx.beginPath(); dctx.arc(cx, cy, R + 5, 0, 6.2832); dctx.stroke();
  }

  // ---------- главный цикл ----------
  let prevTs = 0;
  function loop(ts) {
    const dtReal = Math.min(0.05, (ts - prevTs) / 1000 || 0.0167);
    prevTs = ts;
    if (playing && st) {
      let steps = Math.min(120, Math.round(speed * dtReal / DT));
      for (let k = 0; k < steps; k++) { E.step(st, DT); pushHistory(false); }
      render();
      updateClock();
      if ((frameNo++ & 7) === 0) { updateLegend(); drawCharts(); if (chronDirty) { renderChron(); chronDirty = false; } }
    }
    requestAnimationFrame(loop);
  }

  function updateClock() { $('clock').textContent = 't = ' + st.t.toFixed(1) + ' ч'; }

  function updateLegend() {
    const s = E.stats(st);
    let html = '';
    for (let i = 0; i < 4; i++) {
      if (!st.enabled[i]) continue;
      html += '<span class="lg"><span class="sw" style="background:' + st.species[i].css + '"></span>' +
        st.species[i].name + ': <b>' + fmtExp(s.totals[i]) + '</b></span>';
    }
    if (st.enabled[0] && st.enabled[3]) {
      html += '<span class="lg">доля R: <b>' + (s.resFrac * 100).toFixed(1) + '%</b></span>';
    }
    html += '<span class="lg muted2">S: ' + (s.S / st.env.S0 * 100).toFixed(0) + '% · A: ' +
      (s.A >= 10 ? s.A.toFixed(0) : s.A.toFixed(1)) + ' мг/л</span>';
    $('legend').innerHTML = html;
  }

  // ---------- графики ----------
  const ch1 = $('chart1'), c1 = ch1.getContext('2d');
  const ch2 = $('chart2'), c2 = ch2.getContext('2d');

  function drawCharts() {
    if (!history.length) { c1.clearRect(0, 0, ch1.width, ch1.height); c2.clearRect(0, 0, ch2.width, ch2.height); updatePKBadge(); return; }
    const tEnd = Math.max(24, st.t);
    drawChart1(tEnd);
    drawChart2(tEnd);
    updatePKBadge();
  }

  function drawChart1(tEnd) {
    const w = ch1.width, h = ch1.height;
    c1.fillStyle = '#0b1018'; c1.fillRect(0, 0, w, h);
    const yLo = 3, yHi = 13;
    // сетка десятичных
    c1.strokeStyle = 'rgba(120,150,190,.13)'; c1.fillStyle = '#5f7492'; c1.font = '10px sans-serif';
    for (let e = yLo; e <= yHi; e++) {
      const yy = h - (e - yLo) / (yHi - yLo) * h;
      c1.beginPath(); c1.moveTo(30, yy); c1.lineTo(w - 4, yy); c1.stroke();
      c1.fillText('10' + sup(e), 4, yy + 3);
    }
    // время
    for (let tt = 0; tt <= tEnd; tt += tEnd > 48 ? 12 : 6) {
      const xx = 30 + tt / tEnd * (w - 34);
      c1.fillText(tt + 'ч', Math.min(w - 24, xx), h - 2);
    }
    const anySpecies = [0, 1, 2, 3].filter(function (i) {
      return st.enabled[i] && history.some(function (p) { return p.tot[i] > 100; });
    });
    anySpecies.forEach(function (si) {
      c1.strokeStyle = E.SPECIES[si].css; c1.lineWidth = 1.6; c1.beginPath();
      let pen = false;
      for (let k = 0; k < history.length; k++) {
        const p = history[k], v = p.tot[si];
        if (v <= 100) { pen = false; continue; }
        const xx = 30 + p.t / tEnd * (w - 34);
        const yy = h - (Math.min(yHi, Math.log10(v)) - yLo) / (yHi - yLo) * h;
        if (!pen) { c1.moveTo(xx, yy); pen = true; } else c1.lineTo(xx, yy);
      }
      c1.stroke();
    });
  }

  function drawChart2(tEnd) {
    const w = ch2.width, h = ch2.height;
    c2.fillStyle = '#0b1018'; c2.fillRect(0, 0, w, h);
    const aMax = Math.max(64, history.reduce(function (m, p) { return Math.max(m, p.A); }, 0)) * 1.05;
    // MIC / MPC пунктиром (шкала A)
    c2.setLineDash([4, 3]); c2.font = '10px sans-serif';
    [[E.SPECIES[0].MIC, 'MICwt'], [E.SPECIES[0].MIC * E.MPC_FACTOR, 'MPC']].forEach(function (mr) {
      const yy = h - mr[0] / aMax * (h - 8);
      if (yy < 4) return;
      c2.strokeStyle = 'rgba(255,183,77,.55)';
      c2.beginPath(); c2.moveTo(30, yy); c2.lineTo(w - 4, yy); c2.stroke();
      c2.fillStyle = '#ffb74d'; c2.fillText(mr[1], 32, yy - 2);
    });
    c2.setLineDash([]);
    // S: % от S0 (зелёная), A: мг/л (фиолетовая)
    function line(get, color, norm) {
      c2.strokeStyle = color; c2.lineWidth = 1.6; c2.beginPath();
      for (let k = 0; k < history.length; k++) {
        const p = history[k];
        const v = get(p) / norm;
        const xx = 30 + p.t / tEnd * (w - 34);
        const yy = h - Math.min(1, v) * (h - 8);
        if (k === 0) c2.moveTo(xx, yy); else c2.lineTo(xx, yy);
      }
      c2.stroke();
    }
    line(function (p) { return p.S; }, '#7ee38b', st.env.S0);
    line(function (p) { return p.A; }, '#9c7cff', aMax);
  }

  // ---------- панель видов ----------
  function buildSpeciesPanel() {
    const box = $('speciesList');
    let html = '';
    E.SPECIES.forEach(function (sp, i) {
      html += '<div class="sp-row" id="sprow-' + i + '">' +
        '<div class="sp-head" data-i="' + i + '">' +
        '<input type="checkbox" id="sp-en-' + i + '"' + (i < 1 ? ' checked' : '') + '>' +
        '<span class="sw" style="width:11px;height:11px;border-radius:3px;background:' + sp.css + ';display:inline-block"></span>' +
        '<span class="sp-name">' + sp.name + '</span>' +
        '<span class="sp-count" id="sp-cnt-' + i + '">0</span></div>' +
        '<div class="sp-params">' +
        '<div class="kv"><label>\u03bcmax, ч\u207b\u00b9 (td ' + (Math.LN2 / sp.muMax * 60).toFixed(0) + ' мин)</label>' +
        '<input type="number" id="sp-mu-' + i + '" value="' + sp.muMax + '" step="0.1" min="0.1"></div>' +
        '<div class="kv"><label>MIC амоксиц., мг/л</label>' +
        '<input type="number" id="sp-mic-' + i + '" value="' + sp.MIC + '" step="1" min="0.03"></div>' +
        '<div class="sp-note">' + sp.latin + ' · ' + sp.host + '</div>' +
        '</div></div>';
    });
    box.innerHTML = html;
    E.SPECIES.forEach(function (_, i) {
      $('sprow-' + i).querySelector('.sp-head').addEventListener('click', function (ev) {
        if (ev.target.tagName === 'INPUT') return;
        $('sprow-' + i).classList.toggle('open');
      });
      $('sp-en-' + i).addEventListener('change', function () { toggleSpecies(i); });
      $('sp-mu-' + i).addEventListener('change', resetSim);
      $('sp-mic-' + i).addEventListener('change', resetSim);
    });
  }

  // тоггл вида БЕЗ сброса прогона: включили — вид сразу на чаше (если его не было —
  // сеется капля в свободный слот); выключили — скрыт (клетки остаются в модели).
  // Слоты детерминированы по индексу вида: верх/право/низ/лево от центра.
  function toggleSpecies(i) {
    const row = $('sprow-' + i);
    if (!st) return;
    if ($('sp-en-' + i).checked) {
      st.enabled[i] = true;
      if (row) row.classList.remove('sp-off');
      if (E.stats(st).totals[i] < 1) {
        const a = -Math.PI / 2 + i * Math.PI / 2;
        E.inoculate(st, i, st.cx + Math.cos(a) * st.R * 0.55, st.cy + Math.sin(a) * st.R * 0.55, 1e6, 3);
        logEvent('вид включён — посеян: ' + st.species[i].name, 'man');
      }
    } else {
      st.enabled[i] = false; // скрыть: из рендера/статистики, но клетки в чаше живут
      if (row) row.classList.add('sp-off');
      logEvent('вид скрыт: ' + st.species[i].name, 'man');
    }
    render(); updateLegend(); drawCharts(); updateSpeciesCounts();
  }

  function updateSpeciesCounts() {
    const s = E.stats(st);
    for (let i = 0; i < 4; i++) {
      const el = $('sp-cnt-' + i);
      if (el) el.textContent = fmtExp(s.totals[i]);
    }
  }

  // ---------- инструменты и указатель ----------
  function canvasPos(ev) {
    const rect = dish.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) / rect.width * W,
      y: (ev.clientY - rect.top) / rect.height * H,
    };
  }
  let dragging = false, lastApply = 0;
  function applyTool(ev) {
    const now = performance.now();
    if (now - lastApply < 40) return;
    lastApply = now;
    const p = canvasPos(ev);
    if (!E.inside(st, Math.round(p.x), Math.round(p.y))) return;
    if (tool.kind === 'seed') {
      if (!st.enabled[tool.sp]) { // сеем выключенный вид — включаем, иначе клик «в никуда»
        $('sp-en-' + tool.sp).checked = true;
        toggleSpecies(tool.sp);
      } else {
        E.inoculate(st, tool.sp, p.x, p.y, 1e6, 4);
        logEvent('посев: ' + st.species[tool.sp].name, 'man');
      }
    }
    else if (tool.kind === 'drop') { E.dropAB(st, p.x, p.y, doseVal(), 5); logEvent('капля АБ ' + (doseVal() >= 10 ? doseVal().toFixed(0) : doseVal().toFixed(1)) + ' мг/л', 'man'); }
    else if (tool.kind === 'wipe') {
      const R = 5;
      for (let yy = Math.floor(p.y - R); yy <= p.y + R; yy++)
        for (let xx = Math.floor(p.x - R); xx <= p.x + R; xx++) {
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          if ((xx - p.x) * (xx - p.x) + (yy - p.y) * (yy - p.y) > R * R) continue;
          for (let s = 0; s < 4; s++) st.N[s][yy * W + xx] = 0;
        }
      logEvent('стерты колонии', 'man');
    }
    render(); updateLegend();
  }
  dish.addEventListener('pointerdown', function (ev) { dragging = true; applyTool(ev); });
  window.addEventListener('pointermove', function (ev) { if (dragging) applyTool(ev); });
  window.addEventListener('pointerup', function () { dragging = false; });

  // ---------- probe-тултип: что под курсором ----------
  const probe = $('probe');
  dish.addEventListener('pointermove', function (ev) {
    if (!st || !probe) return;
    const rect = dish.getBoundingClientRect();
    const p = canvasPos(ev);
    const cxi = Math.round(p.x), cyi = Math.round(p.y);
    if (dragging || !E.inside(st, cxi, cyi)) { probe.style.display = 'none'; return; }
    const i = cyi * W + cxi;
    const mic = st.species[0].MIC;
    let rows = '<b>A</b> ' + (st.A[i] >= 10 ? st.A[i].toFixed(0) : st.A[i].toFixed(1)) + ' мг/л (' +
      (st.A[i] / mic).toFixed(1) + '×MIC) · <b>S</b> ' + (st.S[i] / st.env.S0 * 100).toFixed(0) + '%';
    for (let s = 0; s < 4; s++) {
      if (!st.enabled[s] || st.N[s][i] < 1) continue;
      rows += '<br><span class="sw" style="background:' + st.species[s].css + '"></span> ' + st.species[s].name + ': ' + fmtExp(st.N[s][i]);
    }
    if (st.abZones) {
      const f = (p.x - (st.cx - st.R)) / (2 * st.R);
      const zi = f < 0.25 ? 0 : f < 0.5 ? 1 : f < 0.75 ? 2 : 3;
      rows += '<br>полоса: <b>' + ['0 (чисто)', '1×MIC', '10×MIC', '100×MIC'][zi] + '</b>';
    }
    probe.innerHTML = rows;
    probe.style.display = 'block';
    probe.style.left = Math.max(4, Math.min(rect.width - 175, ev.clientX - rect.left + 14)) + 'px';
    probe.style.top = Math.max(4, Math.min(rect.height - 70, ev.clientY - rect.top + 14)) + 'px';
  });
  dish.addEventListener('pointerleave', function () { if (probe) probe.style.display = 'none'; });

  function setTool(kind) {
    tool.kind = kind;
    $('toolSeed').classList.toggle('active', kind === 'seed');
    $('toolDrop').classList.toggle('active', kind === 'drop');
    $('toolWipe').classList.toggle('active', kind === 'wipe');
    $('hint').textContent = kind === 'seed' ? 'Кликай по чаше — сеешь «' + E.SPECIES[tool.sp].name + '» (клик по кнопке меняет вид)'
      : kind === 'drop' ? 'Кликай по чаше — капля антибиотика ' + (doseVal() >= 10 ? doseVal().toFixed(0) : doseVal().toFixed(1)) + ' мг/л'
      : 'Кликай по чаше — стираешь колонии';
  }

  // ---------- тесты моделей ----------
  function runTests(cb) {
    const badge = $('modelBadge');
    badge.textContent = 'модели: проверка\u2026'; badge.className = 'badge';
    $('testsOut').innerHTML = '<div class="t-det">считаю\u2026</div>';
    setTimeout(function () {
      const res = T.runAll();
      const ok = res.filter(function (r) { return r.pass; }).length;
      badge.textContent = 'модели: ' + ok + '/' + res.length + (ok === res.length ? ' \u2713' : ' \u2717');
      badge.className = 'badge ' + (ok === res.length ? 'ok' : 'bad');
      $('testsOut').innerHTML = res.map(function (r) {
        return '<div class="t-row"><div class="t-name ' + (r.pass ? 't-pass">PASS \u2713 ' : 't-fail">FAIL \u2717 ') +
          r.name + '</div><div class="t-det">' + r.details + '</div></div>';
      }).join('');
      if (cb) cb(ok, res.length);
    }, 60);
  }

  // ---------- экспорт / шаринг / проектор ----------
  function download(href, name) {
    const a = document.createElement('a');
    a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(href); }, 3000);
  }
  $('btnCSV').addEventListener('click', function () {
    download(URL.createObjectURL(new Blob([E.buildCSV(history)], { type: 'text/csv;charset=utf-8' })),
      'vetpetri_t' + st.t.toFixed(1) + 'h.csv');
  });
  $('btnPNG').addEventListener('click', function () {
    const a = document.createElement('a');
    a.href = dish.toDataURL('image/png'); a.download = 'vetpetri_dish_t' + st.t.toFixed(1) + 'h.png';
    document.body.appendChild(a); a.click(); a.remove();
  });

  function collectParams() {
    const en = [0, 1, 2, 3].map(function (i) { return $('sp-en-' + i).checked ? 1 : 0; }).join('');
    const mu = [0, 1, 2, 3].map(function (i) { return $('sp-mu-' + i).value; }).join(',');
    const mic = [0, 1, 2, 3].map(function (i) { return $('sp-mic-' + i).value; }).join(',');
    return { p: String(curPreset), seed: $('seed').value, dose: $('dose').value,
      kel: $('kel').value, pMut: $('pMut').value, S0: $('S0').value,
      en: en, mu: mu, mic: mic, mode: $('doseMode').value };
  }
  let lastHashWritten = null;
  $('btnShare').addEventListener('click', function () {
    lastHashWritten = '#' + E.serializeParams(collectParams());
    location.hash = lastHashWritten.slice(1);
    const url = location.href;
    const done = function () {
      $('hint').textContent = 'Ссылка со сценарием — в адресной строке; скопируй и передай студентам';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, done);
    else done();
  });

  function applyFromHash() {
    const hp = E.parseParams(location.hash || '');
    if (!hp || hp.p === undefined) return false;
    if (lastHashWritten !== null && location.hash === lastHashWritten) return false; // сами записали — не переприменять
    const idx = Math.max(0, Math.min(PRESETS.length - 1, parseInt(hp.p, 10) || 0));
    applyPreset(idx);
    try {
      if (hp.seed !== undefined) $('seed').value = parseInt(hp.seed, 10) || 42;
      if (hp.dose !== undefined) $('dose').value = hp.dose;
      if (hp.kel !== undefined) $('kel').value = hp.kel;
      if (hp.pMut !== undefined) $('pMut').value = hp.pMut;
      if (hp.S0 !== undefined) $('S0').value = hp.S0;
      if (hp.mode !== undefined) $('doseMode').value = hp.mode;
      if (hp.en) for (let i = 0; i < 4; i++) $('sp-en-' + i).checked = hp.en[i] === '1';
      if (hp.mu) hp.mu.split(',').forEach(function (v, i) { if ($('sp-mu-' + i)) $('sp-mu-' + i).value = v; });
      if (hp.mic) hp.mic.split(',').forEach(function (v, i) { if ($('sp-mic-' + i)) $('sp-mic-' + i).value = v; });
      updateDoseUI();
    } catch (e) { /* битый hash — играем по пресету */ }
    resetSim();
    return true;
  }
  window.addEventListener('hashchange', applyFromHash); // вставили ссылку-сценарий в открытый таб — применилось

  $('btnProj').addEventListener('click', function () {
    const on = document.body.classList.toggle('projector');
    this.classList.toggle('active', on);
  });
  // ---------- инициализация ----------
  function init() {
    buildSpeciesPanel();
    $('dose').value = 60; // 10^0.6 ≈ 4 мг/л = 1×MICwt
    updateDoseUI();

    document.querySelectorAll('.pbtn').forEach(function (b) {
      b.addEventListener('click', function () { applyPreset(+b.dataset.p); });
    });
    $('btnPlay').addEventListener('click', function () {
      playing = !playing;
      $('btnPlay').textContent = playing ? '\u23f8 Пауза' : '\u25b6 Пуск';
    });
    $('btnStep').addEventListener('click', function () {
      for (let k = 0; k < 50; k++) { E.step(st, DT); pushHistory(false); }
      render(); updateClock(); updateLegend(); drawCharts();
    });
    $('btnReset').addEventListener('click', resetSim);
    $('selSpeed').addEventListener('change', function () { speed = parseFloat(this.value); });
    $('dose').addEventListener('input', updateDoseUI);
    $('doseMode').addEventListener('change', resetSim);
    $('kel').addEventListener('change', resetSim);
    $('S0').addEventListener('change', resetSim);
    $('pMut').addEventListener('change', resetSim);
    $('btnSeedRnd').addEventListener('click', function () {
      $('seed').value = Math.floor(Math.random() * 99999) + 1; resetSim();
    });
    $('seed').addEventListener('change', resetSim);
    $('toolSeed').addEventListener('click', function () {
      if (tool.kind === 'seed') {
        let n = tool.sp;
        for (let k = 0; k < 5; k++) { n = (n + 1) % 4; if (E.SPECIES[n] && $('sp-en-' + n).checked) break; }
        tool.sp = n;
        $('toolSeedName').textContent = E.SPECIES[n].name;
      } else { tool.sp = 0; $('toolSeedName').textContent = E.SPECIES[0].name; }
      setTool('seed');
    });
    $('toolDrop').addEventListener('click', function () { setTool('drop'); });
    $('toolWipe').addEventListener('click', function () { setTool('wipe'); });
    $('btnLawn').addEventListener('click', function () { E.lawn(st, 0, 1e7); render(); updateLegend(); logEvent('газон E. coli по всей чаше', 'man'); });
    $('btnBolus').addEventListener('click', function () { E.bolusAB(st, doseVal()); render(); logEvent('болюс АБ ' + (doseVal() >= 10 ? doseVal().toFixed(0) : doseVal().toFixed(1)) + ' мг/л всю чашу', 'man'); });
    $('btnTests').addEventListener('click', function () { runTests(); });
    $('micTick').textContent = 'MIC ' + E.SPECIES[0].MIC;
    $('mpcTick').textContent = 'MPC ' + E.SPECIES[0].MIC * E.MPC_FACTOR;

    applyPreset(0);
    if (location.hash && location.hash.length > 1) applyFromHash(); // ссылка-сценарий из методички
    requestAnimationFrame(loop);
    setTimeout(function () { runTests(); }, 400);
    setInterval(function () { if (st) { updateSpeciesCounts(); } }, 700);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
