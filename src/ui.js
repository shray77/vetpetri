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
  let layer = 'biomass'; // слой чаши (F10): biomass | S | A | mu
  let history = [], lastPush = -1, frameNo = 0, curPreset = 0;
  let chron = [], chronFl = null, chronDirty = false; // хроника событий (v1.2)

  // ---------- параметры видов из UI ----------
  // Task 184 (урок Task 178: молчаливое «самоисправление» хуже явной ошибки): «0»/мусор/
  // отрицательное значение в μmax/MIC больше не подставляет видовой дефолт ТИХО —
  // валидация с честным сообщением в hint и возвратом поля к дефолту. Ks в UI не вводится.
  function paramOrReject(inp, def, min, what, spName) {
    const raw = inp.value;
    const v = parseFloat(raw);
    if (!isFinite(v) || v < min) {
      if ($('hint')) $('hint').textContent = 'Параметр «' + what + '» (' + spName + '): «' + raw +
        '» не годится — нужно число ≥ ' + min + '. Вернул ' + def + '.';
      inp.value = def;
      return def;
    }
    return v;
  }
  function uiSpecies() {
    const list = [];
    for (let i = 0; i < E.SPECIES.length; i++) {
      const sp = E.SPECIES[i];
      list.push(Object.assign({}, sp, {
        muMax: paramOrReject($('sp-mu-' + i), sp.muMax, 0.1, 'μmax', sp.name),
        MIC: paramOrReject($('sp-mic-' + i), sp.MIC, 0.01, 'MIC', sp.name),
        enabled: $('sp-en-' + i).checked,
      }));
    }
    return list;
  }

  function readUIEnv() {
    const half = Math.max(0, parseFloat($('kel').value) || 0);
    const pers = $('persMode') ? $('persMode').value : 'off';
    return {
      S0: Math.max(50, parseFloat($('S0').value) || 1000),
      kel: half > 0 ? Math.LN2 / half : 0,
      pMut: parseFloat($('pMut').value) || 0,
      // персистеры (v1.3): значения a/b — Balaban 2004 (WT: 1.2e-6/0.1; hipQ: 1e-3/1e-4 —
      // верх границы 1e-6…1e-4, в статье «poorly determined»)
      persA: pers === 'wt' ? 1.2e-6 : pers === 'hip' ? 1e-3 : 0,
      persB: pers === 'wt' ? 0.1 : 1e-4,
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
      drug: $('drugMode') ? $('drugMode').value : 'amox', // v1.4: класс АБ (kmax/H/PAE/coupling)
      dosing: { mode: $('doseMode').value, dose: doseVal() },
      abZones: curPreset === 5 ? MEGA_ZONES : null,
    });
    return s;
  }

  // ---------- v1.4: переключение класса антибиотика (UI-обвязка) ----------
  // Меняет: селектор, MIC-инпуты видов (MIC ↔ MIC2), t½, диапазон слайдера дозы,
  // подписи MIC/MPC и заголовок секции. MIC активного препарата — свойство вида
  // в текущем прогоне: движок агностичен, переключение значений — здесь.
  function setDrugUI(id, doReset) {
    const d = E.DRUGS[id] || E.DRUGS.amox;
    const enro = d.id === 'enro';
    if ($('drugMode')) $('drugMode').value = d.id;
    for (let i = 0; i < E.SPECIES.length; i++) {
      const inp = $('sp-mic-' + i);
      if (inp) inp.value = enro ? E.SPECIES[i].MIC2 : E.SPECIES[i].MIC;
    }
    if ($('kel')) $('kel').value = d.kelHalf;
    if ($('dose')) $('dose').min = enro ? -160 : -10; // энро: до 0.025 мг/л (MIC 0.06 — нужны доли)
    const mic0 = enro ? E.SPECIES[0].MIC2 : E.SPECIES[0].MIC;
    if ($('micTick')) $('micTick').textContent = 'MIC ' + (mic0 < 1 ? mic0.toFixed(2) : mic0);
    if ($('mpcTick')) $('mpcTick').textContent = 'MPC ' + (mic0 * E.MPC_FACTOR < 1 ? (mic0 * E.MPC_FACTOR).toFixed(2) : (mic0 * E.MPC_FACTOR).toFixed(1));
    if ($('abTitle')) $('abTitle').textContent = 'Антибиотик — ' + (enro ? 'энрофлоксацин' : 'амоксициллин');
    if ($('abCls')) $('abCls').textContent = d.cls;
    if (doReset) resetSim();
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
    { steps: ['Суточная доза 99 мг/л (слайдер), режим «1 болюс» → Пуск. Смотри фиолетовую кривую и бейдж T>MIC.',
      'Сброс, та же доза в режиме «инфузия 24 ч» → сравни T>MIC и форму кривой КОЕ.',
      'Повтори с «3 введения (q8h)» — три промежуточных пика. (При малых дозах вроде 32 инфузия не добирается до MIC — A_ss = доза/(24·t½): вот почему доза и режим не независимы.)'],
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
    { steps: ['Пресет 7 (энрофлоксацин, болюс 0.15 мг/л = 2.5×MIC) → Пуск: газон падает на порядки, β-лактамазный клон — вместе с ним.',
      'Сбрось и переключи режим на «инфузия 24 ч» (та же доза) — почти ничего не происходит: A ниже MIC всю сутки.',
      'Поднимай дозу и следи за бейджем AUC24/MIC: цель ≥ 125, а при 0.15 мг/л — ≈ 9.'],
      q: 'Одна и та же доза болюсом и инфузией: для амоксициллина лечит инфузия (Т5), а здесь?',
      a: 'Фторхинолоны концентрационно-зависимы: решает ПИК (Cmax/MIC) и суммарная экспозиция (AUC/MIC ≥ 125), а не время выше MIC. Доза та же → AUC тот же, режим меняет только пик.' },
  ];

  function lectureHTML(idx) {
    const L = LECTURES[idx];
    if (!L) return '';
    return '<details class="lecture"><summary>Сценарий для пары</summary><ol>' +
      L.steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>' +
      '<div class="lq"><b>Вопрос:</b> ' + L.q + '</div>' +
      '<div class="la"><b>Вывод:</b> ' + L.a + '</div></details>' + challengeHTML(idx);
  }

  // ---------- челлендж-карточки (F13, e-Bug style): предскажи → проверь ----------
  const CHALLENGES = [
    [ { q: 'Капля 10⁶ КОЕ, скорость 8 ч/с, ждём сутки. Что будет с популяцией?',
        opts: ['вымрет — еда кончится', '≈10⁹ — упрётся в ёмкость среды', '≈10¹² — будет расти без предела'], ok: 1,
        why: 'Плато ≈ ёмкость: локально Nmax на ячейку, итого площадь × Nmax. Дальше — медленное отмирание.' },
      { q: 'Первые ~2 часа кривая почти плоская. Почему?',
        opts: ['симуляция «прогревается»', 'лаг-фаза: адаптация по Бараньи (q-функция)', 'в агаре есть антибиотик'], ok: 1,
        why: 'Лаг-фаза — физиологическая адаптация, не артефакт. Потом — экспонента с td ≈ 20 мин.' } ],
    [ { q: 'E. coli (μmax 2.1) и Salmonella (μmax 1.4) делят общий субстрат. Кто возьмёт чашу?',
        opts: ['Salmonella — она стабильнее', 'E. coli — быстрее истощает общий ресурс', 'поделятся ровно пополам'], ok: 1,
        why: 'Эксплуатационная конкуренция: быстрее растущий быстрее съедает общий субстрат и давит соседа.' },
      { q: 'Ставишь Salmonella μmax = 2.0 и сбрасываешь. Что изменится?',
        opts: ['исход соперничества развернётся', 'ничего — μmax ни на что не влияет', 'оба вида вымрут'], ok: 0,
        why: 'При близких μmax исход решают Ks и стартовая позиция — проверь на границе колоний.' } ],
    [ { q: 'Одна и та же суточная доза: где T>MIC выше — «1 болюс» или «инфузия 24 ч»?',
        opts: ['у болюса — пик выше, значит и T>MIC выше', 'у инфузии — концентрация постоянно держится над MIC', 'одинаково — доза-то та же'], ok: 1,
        why: 'Dose fractionation: та же доза в инфузии держит A над MIC почти все сутки. Для β-лактамов цель fT>MIC 40–70% (Berry 2022).' },
      { q: 'Болюс 32 мг/л, t½ = 1 ч. Что происходит через ~5 часов?',
        opts: ['гибель продолжается — АБ накапливается', 'АБ упал ниже MIC — выжившие отрастают', 'бактерии переходят в биоплёнку'], ok: 1,
        why: 'За ~5 ч концентрация падает в ~32 раза — ниже MIC. Дальше решают выжившие: регроу.' } ],
    [ { q: 'Какая доза «растит» больше всего мутантов?',
        opts: ['низкая (0.5 мг/л — ниже MIC)', 'средняя (8 мг/л — между MIC и MPC)', 'очень высокая (256 мг/л — выше MPC)'], ok: 1,
        why: 'Окно селекции MIC…MPC (Drlica): wt подавлен, а мутант растёт без конкурента. «Пол-таблетки» — самый дорогой способ сэкономить.' },
      { q: 'Что такое MPC на шкале дозы?',
        opts: ['концентрация, подавляющая и первый мутант', 'максимально переносимая концентрация', 'доза, при которой растут оба вида'], ok: 0,
        why: 'Mutant prevention concentration ≈ 8×MIC (Drlica & Zhao): выше неё нет ни wt, ни первого мутанта — некому расти.' } ],
    [ { q: 'Капля АБ 32 мг/л в газон. Где выжившие, если включить мутации?',
        opts: ['в центре капли — там доза максимальна', 'кольцом на краю — там концентрация в окне селекции', 'нигде — доза летальна везде'], ok: 1,
        why: 'Градиент от капли = живое окно селекции: на краю A между MIC и MPC — мутант в преимуществе.' },
      { q: 'Стираешь колонию ластиком и сеешь новую. Кривая КОЕ это заметит?',
        opts: ['да — статистика считается с живой чаши', 'нет — график не обновляется', 'только после сброса сценария'], ok: 0,
        why: 'Легенда, график и хроника читают текущее состояние каждый кадр.' } ],
    [ { q: 'Почему wt не проходит полосу 1×MIC в мега-чаше?',
        opts: ['он там мгновенно умирает', 'на MIC чистая скорость = 0 — фронт останавливается', 'ему не хватает места в полосе'], ok: 1,
        why: 'C50 откалиброван так, что net-рост = 0 при A = MIC — это и есть определение MIC. Смотри PD-профиль под графиками.' },
      { q: 'Мутант дошёл до полосы 100×MIC и встал. Что говорит Baym 2016 о том, что дальше?',
        opts: ['нужна следующая мутация — каждая полоса трамплин', 'мутант вернётся в нулевую зону', 'эволюция закончилась навсегда'], ok: 0,
        why: 'Ступенчатая эволюция: в реальном эксперименте Kishony lab популяция шла через 1→10→100× серией последовательных мутаций.' } ],
    [ { q: 'Энрофлоксацин болюсом 2.5×MIC валит газон E. coli. А что будет с клоном β-лактамазы (MIC амоксициллина 64)?',
        opts: ['выживет — у него же резистентность', 'погибнет вместе с wt — β-лактамаза не действует на фторхинолоны', 'погибнет первым — он всегда слабее'], ok: 1,
        why: 'TEM-разрушает β-лактамное кольцо, а фторхинолон бьёт ДНК-гиразу — другой класс, другая мишень. Кросс-защиты нет: смена класса — способ обойти фермент.' },
      { q: 'Та же суточная доза энро: болюс или инфузия убьёт больше?',
        opts: ['инфузия — дольше держит A выше MIC', 'болюс — выше пик, а фторхинолон концентрационно-зависим', 'одинаково — доза та же'], ok: 1,
        why: 'AUC у режимов почти равна (доза одна), но убивает ПИК: Cmax/MIC ≥ 8–10. Для β-лактамов наоборот — лечит время (T>MIC 40–70%).' } ],
  ];

  function challengeHTML(idx) {
    const list = CHALLENGES[idx];
    if (!list || !list.length) return '';
    return '<details class="chals"><summary>Челленджи — предскажи, потом проверь</summary>' +
      list.map(function (c, k) {
        return '<details class="chal"><summary>Ч' + (k + 1) + '. ' + c.q + '</summary>' +
          '<ol class="chopts">' + c.opts.map(function (o) { return '<li>' + o + '</li>'; }).join('') + '</ol>' +
          '<div class="chans"><b>Ответ ' + 'АБВГ'[c.ok] + '.</b> ' + c.why + '</div></details>';
      }).join('') + '</details>';
  }

  // ---------- пресеты-эксперименты ----------
  const PRESETS = [
    {
      name: 'Кривая роста',
      note: '<b>Кинетика Моно на одном виде.</b> Капля E. coli в чистой чаше: лаг-фаза (~2 ч, адаптация по Бараньи) → экспонента (удвоение ~20 мин) → плато (субстрат исчерпан, выход ≈ Y·S\u2080) → медленное отмирание. На нижнем графике зелёная кривая — субстрат тает по мере роста.',
      ui: function () {
        setDrugUI('amox', false);
        $('sp-en-0').checked = true; $('sp-en-1').checked = false; $('sp-en-2').checked = false; $('sp-en-3').checked = false;
        $('kel').value = 1.0; $('pMut').value = '0'; $('doseMode').value = 'bolus'; $('persMode').value = 'off';
      },
      setup: function (s) {
        E.inoculate(s, 0, s.cx, s.cy, 1e6, 4);
      },
    },
    {
      name: 'Конкуренция видов',
      note: '<b>Два вида против общего субстрата</b> (эксплуатационная конкуренция, родственник Лотки–Вольтерры с общим ресурсом). E. coli (быстрорастущий) против Salmonella Dublin. Следи за границей колоний: кто первым захватывает субстрат, тот и давит соседа.',
      ui: function () {
        setDrugUI('amox', false);
        $('sp-en-0').checked = true; $('sp-en-1').checked = true; $('sp-en-2').checked = false; $('sp-en-3').checked = false;
        $('kel').value = 1.0; $('pMut').value = '0'; $('doseMode').value = 'bolus'; $('persMode').value = 'off';
      },
      setup: function (s) {
        E.inoculate(s, 0, s.cx - s.R * 0.45, s.cy, 5e6, 4);
        E.inoculate(s, 1, s.cx + s.R * 0.45, s.cy, 5e6, 4);
      },
    },
    {
      name: 'Time-kill: режим введения',
      note: '<b>Фармакодинамика амоксициллина (Хилл/Emax) + dose fractionation.</b> Газон E. coli + суточная доза из слайдера, внесённая по выбранному режиму: «1 болюс» / «3 введения (q8h)» / «инфузия 24 ч». Кривая КОЕ: лог-линейный спад (kmax ≈ 3 ч⁻¹), потом регроу, когда концентрация (фиолетовая) падает ниже MIC. Бейдж T>MIC — доля первых суток выше MIC: для β-лактамов цель 40–70% (Berry 2022). <b>Персистеры включены (дикий тип, Balaban 2004)</b>: тонкий дормантный хвост переживает болюс; переключи на «hipQ-мутант» в разделе антибиотика — резервуар вырастет на три порядка.',
      ui: function () {
        setDrugUI('amox', false);
        $('sp-en-0').checked = true; $('sp-en-1').checked = false; $('sp-en-2').checked = false; $('sp-en-3').checked = false;
        $('kel').value = 1.0; $('pMut').value = '0'; $('persMode').value = 'wt';
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
        setDrugUI('amox', false);
        $('sp-en-0').checked = true; $('sp-en-1').checked = false; $('sp-en-2').checked = false; $('sp-en-3').checked = true;
        $('kel').value = 0; $('pMut').value = '0'; $('doseMode').value = 'bolus'; $('persMode').value = 'off';
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
        setDrugUI('amox', false);
        $('sp-en-0').checked = true; $('sp-en-1').checked = true; $('sp-en-2').checked = true; $('sp-en-3').checked = false;
        $('kel').value = 1.0; $('pMut').value = '1e-6'; $('doseMode').value = 'bolus'; $('persMode').value = 'off';
      },
      setup: function (s) {},
    },
    {
      name: 'Мега-чаша: лестница доз',
      note: '<b>Эксперимент Kishony lab (Baym 2016, Science).</b> Чаша разделена на полосы антибиотика 0 → 1× → 10× → 100× MICwt. Газон E. coli по всей чаше + редкий R-клон (β-лактамаза, MIC 64) в нулевой зоне слева. wt упирается в полосу 1×MIC (net-рост = 0), мутант прорывает её, медленно идёт через 10× и стопорится на 100×. Каждая полоса — трамплин ступенчатой эволюции. Слайдер дозы здесь не действует — концентрации задают полосы.',
      ui: function () {
        setDrugUI('amox', false);
        $('sp-en-0').checked = true; $('sp-en-1').checked = false; $('sp-en-2').checked = false; $('sp-en-3').checked = true;
        $('kel').value = 1.0; $('pMut').value = '1e-6'; $('doseMode').value = 'bolus'; $('persMode').value = 'off';
      },
      setup: function (s) {
        E.lawn(s, 0, 1e7);                                   // газон wt по всей чаше
        E.inoculate(s, 3, s.cx - s.R * 0.8, s.cy, 1e4, 2);   // R-клон в нулевой зоне
        $('selSpeed').value = '20'; speed = 20;
      },
    },
    {
      name: 'Класс АБ: β-лактам vs фторхинолон',
      note: '<b>Два класса — две философии дозирования (v1.4).</b> Газон E. coli + 1% «устойчивого» клона (β-лактамаза TEM, MIC амоксициллина 64) — и энрофлоксацин: фторхинолон концентрационно-зависимый (крутая Хилл-кривая kmax 8, H 1.6), бьёт и неделящихся, с пост-антибиотическим эффектом ~2 ч. Суточная доза 0.15 мг/л = 2.5×MIC. Сравни с пресетом 3: для β-лактама лечит инфузия (T>MIC), для фторхинолона — ПИК: болюс той же дозы валит популяцию на порядки глубже, а инфузия держит A ниже MIC — почти не работает. Бейдж AUC24/MIC: при 0.15 мг/л — ≈ 9 (до цели ≥ 125 далеко — подними дозу до ~2 мг/л и добери). Доза та же → AUC тот же, режим меняет только пик. И главное: β-лактамазный клон гибнет вместе с wt — фермент против фторхинолона бесполезен (другая мишень, ДНК-гираза).',
      ui: function () {
        setDrugUI('enro', false);
        $('sp-en-0').checked = true; $('sp-en-1').checked = false; $('sp-en-2').checked = false; $('sp-en-3').checked = true;
        $('kel').value = 3.0; $('pMut').value = '0'; $('doseMode').value = 'bolus'; $('persMode').value = 'off';
        setDoseSlider(0.15);
      },
      setup: function (s) {
        E.lawn(s, 0, 1e7);
        E.lawn(s, 3, 1e5);
        E.initDose(s);
      },
    },
  ];

  // ---------- доза ----------
  function doseVal() { return Math.pow(10, parseInt($('dose').value, 10) / 100); }
  function setDoseSlider(v) { $('dose').value = Math.round(100 * Math.log10(Math.max(0.1, Math.min(256, v)))); updateDoseUI(); }
  function updateDoseUI() {
    const d = doseVal();
    const mic = st && st.species[0] ? st.species[0].MIC : E.SPECIES[0].MIC; // MIC активного АБ
    const x = d / mic;
    $('doseVal').textContent = (d >= 10 ? d.toFixed(0) : d >= 1 ? d.toFixed(1) : d.toFixed(2)) + '\u00a0мг/л';
    $('doseX').textContent = '= ' + (x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2)) + '\u00d7MICwt';
  }

  // ---------- PK: бейдж PD-индекса (v1.4 — по классу АБ) ----------
  // амоксициллин: T>MIC — доля первых суток выше MICwt, цель 40–70% (Berry 2022);
  // энрофлоксацин: AUC24/MIC (цель ≥ 100–125, McKellar & Preston 2004) + Cmax/MIC (≥ 8–10).
  // Task 184: оба индекса — из одного E.pdIndices (унификация методик: раньше амоксициллин
  // считался поточечно, энро — интерполяцией пересечений порога).
  function updatePKBadge() {
    const el = $('pkBadge');
    if (!el) return;
    if ((curPreset !== 2 && curPreset !== 6) || !st || !history.length) { el.style.display = 'none'; return; }
    const mic = st.species[0].MIC;
    const modeName = $('doseMode').value;
    const modeLabel = modeName === 'bolus' ? '1 болюс' : modeName === 'q8h' ? '3 введения' : 'инфузия';
    if (st.drugId === 'enro') {
      const pi = E.pdIndices(history, mic);
      if (!pi) { el.style.display = 'none'; return; }
      el.style.display = '';
      const aucOk = pi.aucMic >= 100; // фторхинолоны: ≥ 100–125 для грамотрицательных
      el.textContent = 'AUC24/MIC: ' + pi.aucMic.toFixed(0) + ' [цель ≥ 125] · Cmax/MIC: ' +
        pi.cmaxMic.toFixed(1) + ' [≥ 8–10] [' + modeLabel + '] — доза та же → AUC тот же, режим меняет только пик';
      el.className = 'pk-badge ' + (aucOk ? 'ok' : 'bad');
    } else {
      // Task 184: T>MIC — как и AUC-бейдж выше, из E.pdIndices (линейные пересечения порога),
      // а не поточечный подсчёт доли записей истории
      const pi = E.pdIndices(history, mic);
      if (!pi) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.textContent = 'T>MIC (0–24\u00a0ч): ' + (pi.fTMIC * 100).toFixed(0) + '% [' + modeLabel +
        '] · цель для β-лактамов 40–70%';
      el.className = 'pk-badge ' + (pi.fTMIC >= 0.4 ? 'ok' : 'bad');
    }
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
    drawEmax();
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
      html += '<div class="ev"><span class="dot ' + e.cls + '"></span>t=' + e.t.toFixed(1) + '\u00a0ч — ' + e.txt + '</div>';
    }
    box.innerHTML = html || '<div class="ev muted">пока тихо — события появятся по ходу прогона</div>';
    box.scrollTop = 0;
  }

  // ---------- рендер чаши ----------
  // Слои (F10): biomass — колонии в цветах видов + вуаль АБ (как в v1.0);
  // S — теплокарта субстрата; A — теплокарта антибиотика; mu — чистая скорость
  // доминирующего вида (рост − гибель − отмирание): зелёный растёт, красный гибнет.
  function render() {
    const d = img.data, S = st.S, A = st.A, N = st.N, S0 = st.env.S0;
    const spc = st.species, en = st.enabled, Nmax = st.env.Nmax;
    const hasP = !!st._pers;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, p = i * 4;
        if (!E.inside(st, x, y)) { d[p + 3] = 0; continue; }
        if (layer === 'S') { // теплокарта субстрата: голодный тёмный → сытый зелёный
          const fed = Math.min(1, S[i] / S0);
          d[p] = 12 + fed * 42; d[p + 1] = 16 + fed * 178; d[p + 2] = 20 + fed * 72; d[p + 3] = 255;
          continue;
        }
        if (layer === 'A') { // теплокарта антибиотика: тёмный → фиолетовый
          const aA = A[i] / (A[i] + 6);
          d[p] = 15 + aA * 205; d[p + 1] = 10 + aA * 95; d[p + 2] = 24 + aA * 231; d[p + 3] = 255;
          continue;
        }
        if (layer === 'mu') { // чистая скорость доминирующего вида (1/ч)
          let ntot = 0, sMax = -1, nMaxV = 0;
          for (let s = 0; s < 4; s++) {
            if (!en[s]) continue;
            const n = N[s][i] + (hasP ? st.P[s][i] : 0);
            ntot += n;
            if (n > nMaxV) { nMaxV = n; sMax = s; }
          }
          if (nMaxV < 1) { d[p] = 16; d[p + 1] = 18; d[p + 2] = 22; d[p + 3] = 255; continue; }
          const sp = spc[sMax];
          const crow = Math.max(0, 1 - ntot / Nmax);
          const lagF = st.q[sMax] / (1 + st.q[sMax]);
          const sat = S[i] / (sp.Ks + S[i]);
          const Ai = A[i];
          const c50 = (st._c50 || (st._c50 = st.species.map(function (sp2) { return E.c50Of(sp2, st.env); })))[sMax];
          const kill = sp.kmax * Math.pow(Ai, sp.H) / (Math.pow(Ai, sp.H) + c50);
          const net = sp.muMax * lagF * sat * crow - kill * (0.2 + 0.8 * sat) - sp.kd;
          if (net >= 0) {
            const m = Math.min(1, net / 2);
            d[p] = 14 + m * 70; d[p + 1] = 20 + m * 215; d[p + 2] = 24 + m * 60;
          } else {
            const m = Math.min(1, -net / 3);
            d[p] = 30 + m * 225; d[p + 1] = 20 + m * 40; d[p + 2] = 26 + m * 60;
          }
          d[p + 3] = 255;
          continue;
        }
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

  function updateClock() { $('clock').textContent = 't = ' + st.t.toFixed(1) + '\u00a0ч'; }

  // слой чаши (F10): переключение + подсказка
  function setLayer(l) {
    layer = l;
    document.querySelectorAll('#layerBar .tool').forEach(function (b) { b.classList.toggle('active', b.dataset.layer === l); });
    $('hint').textContent =
      l === 'biomass' ? 'Слой «Клетки»: колонии в цветах видов, фиолетовая вуаль — антибиотик' :
      l === 'S' ? 'Слой «Субстрат»: зеленее = больше еды; фронт колонии объедает агар впереди' :
      l === 'A' ? 'Слой «Антибиотик»: светлее = выше концентрация; в мега-чаше — полосы' :
      'Слой «Рост μ»: зелёный — растёт, красный — гибнет, чёрный — на месте (граница = MIC)';
  }

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
      (s.A >= 10 ? s.A.toFixed(0) : s.A.toFixed(1)) + '\u00a0мг/л</span>';
    if (st._pers) html += '<span class="lg muted2">персистеры: ' + fmtExp(s.pers) + '</span>';
    $('legend').innerHTML = html;
  }

  // ---------- графики ----------
  const ch1 = $('chart1'), c1 = ch1.getContext('2d');
  const ch2 = $('chart2'), c2 = ch2.getContext('2d');

  // Task 184: читаемые оси на мобильных. Канвы больше не «сжимаются» CSS-ом из 960px-буфера
  // (на 380px-экране 10px-шрифт осей превращался в ~4px): буфер перезадаём под фактическую
  // ширину контейнера × devicePixelRatio и рисуем в CSS-пикселях (setTransform); шрифт осей —
  // max(10px CSS, пропорция от канонической 960px-канвы) — на десктопе ≥960px вид прежний.
  // hCss0 — высота канонической канвы (170/130/160): пропорцию и CSS-высоту сохраняем.
  function fitChart(cv, hCss0) {
    const cw = cv.clientWidth || 960; // details закрыт (chart3) — каноническая ширина
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const hCss = hCss0 * cw / 960;
    const bw = Math.round(cw * dpr), bh = Math.round(hCss * dpr);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // перезапись width сбрасывает состояние контекста
    return { w: cw, h: hCss, font: Math.max(10, 10 * cw / 960) };
  }

  function drawCharts() {
    if (!history.length) {
      const a = fitChart(ch1, 170), b = fitChart(ch2, 130);
      c1.clearRect(0, 0, a.w, a.h); c2.clearRect(0, 0, b.w, b.h);
      updatePKBadge(); return;
    }
    const tEnd = Math.max(24, st.t);
    drawChart1(tEnd);
    drawChart2(tEnd);
    updatePKBadge();
  }

  function drawChart1(tEnd) {
    const f = fitChart(ch1, 170), w = f.w, h = f.h;
    c1.fillStyle = '#0b1018'; c1.fillRect(0, 0, w, h);
    const yLo = 3, yHi = 13;
    // сетка десятичных; Task 184: подписи осей #6a80a0 — 4.76:1 на #0b1018 (было #5f7492 = 3.99:1)
    c1.strokeStyle = 'rgba(120,150,190,.13)'; c1.fillStyle = '#6a80a0'; c1.font = f.font.toFixed(1) + 'px sans-serif';
    for (let e = yLo; e <= yHi; e++) {
      const yy = h - (e - yLo) / (yHi - yLo) * h;
      c1.beginPath(); c1.moveTo(30, yy); c1.lineTo(w - 4, yy); c1.stroke();
      c1.fillText('10' + sup(e), 4, yy + 3);
    }
    // время
    for (let tt = 0; tt <= tEnd; tt += tEnd > 48 ? 12 : 6) {
      const xx = 30 + tt / tEnd * (w - 34);
      c1.fillText(tt + '\u00a0ч', Math.min(w - 24, xx), h - 2);
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
    const f = fitChart(ch2, 130), w = f.w, h = f.h;
    c2.fillStyle = '#0b1018'; c2.fillRect(0, 0, w, h);
    const aMax = Math.max(64, history.reduce(function (m, p) { return Math.max(m, p.A); }, 0)) * 1.05;
    // MIC / MPC пунктиром (шкала A) — активного препарата
    c2.setLineDash([4, 3]); c2.font = f.font.toFixed(1) + 'px sans-serif';
    [[st.species[0].MIC, 'MICwt'], [st.species[0].MIC * E.MPC_FACTOR, 'MPC']].forEach(function (mr) {
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

  // ---------- PD-профиль (F9): чистая скорость роста vs концентрация АБ ----------
  // net(A) = рост (Моно, сытая среда) − гибель (Хилл/Emax) − отмирание.
  // Ноль кривой = MIC по построению (C50 откалиброван на net=0 при A=MIC).
  // Пунктир — та же кривая в голодной зоне (sat=0.05): β-лактам бьёт делящиеся,
  // поэтому голодные клетки выживают при концентрациях ниже MIC — это и есть
  // фенотипическая защита, из которой растут персистеры.
  const ch3 = $('chart3'), c3 = ch3 ? ch3.getContext('2d') : null;
  function drawEmax() {
    if (!c3 || !st) return;
    const f = fitChart(ch3, 160), w = f.w, h = f.h;
    c3.fillStyle = '#0b1018'; c3.fillRect(0, 0, w, h);
    const xLo = st.drugId === 'enro' ? -1.8 : -0.8, xHi = 2.7; // log10 A: энро — от 0.016, амокс. — от 0.16 мг/л
    const yLo = -3.4, yHi = 2.6; // 1/ч
    const X = function (lg) { return 34 + (lg - xLo) / (xHi - xLo) * (w - 42); };
    const Y = function (v) { return h - 4 - (v - yLo) / (yHi - yLo) * (h - 16); };
    // Task 184: подписи осей #6a80a0 — 4.76:1 на #0b1018 (было #5f7492 = 3.99:1), шрифт от ширины канвы
    c3.strokeStyle = 'rgba(120,150,190,.13)'; c3.fillStyle = '#6a80a0'; c3.font = f.font.toFixed(1) + 'px sans-serif';
    for (let v = -3; v <= 2; v++) {
      const yy = Y(v);
      c3.beginPath(); c3.moveTo(34, yy); c3.lineTo(w - 6, yy); c3.stroke();
      c3.fillText((v > 0 ? '+' : '') + v, 8, yy + 3);
    }
    for (let lg = st.drugId === 'enro' ? -1.5 : -0.5; lg <= 2.5; lg++) c3.fillText(Math.pow(10, lg).toFixed(lg < 0 ? 2 : lg < 1 ? 1 : 0), X(lg) - 6, h - 2);
    c3.fillText('мг/л', w - 28, h - 2);
    c3.fillText('ч⁻¹', 8, 10);
    // нулевая линия
    c3.strokeStyle = 'rgba(219,231,244,.5)';
    c3.beginPath(); c3.moveTo(34, Y(0)); c3.lineTo(w - 6, Y(0)); c3.stroke();
    // вертикали MICwt / MPC
    c3.setLineDash([4, 3]);
    [[st.species[0].MIC, 'MICwt'], [st.species[0].MIC * E.MPC_FACTOR, 'MPC']].forEach(function (mr) {
      const xx = X(Math.log10(Math.max(1e-3, mr[0])));
      c3.strokeStyle = 'rgba(255,183,77,.5)';
      c3.beginPath(); c3.moveTo(xx, 6); c3.lineTo(xx, Y(yLo) - 2); c3.stroke();
      c3.fillStyle = '#ffb74d'; c3.fillText(mr[1], xx + 3, 12);
    });
    c3.setLineDash([]);
    // кривые по включённым видам + пунктир «голодная зона» для wt
    st.species.forEach(function (sp, s) {
      if (!st.enabled[s]) return;
      const g = Math.max(0.2, sp.muMax - sp.kd);
      const c50 = E.c50Of(sp, st.env);
      const c50H = Math.pow(c50, sp.H); // v1.4-фикс: знаменатель Хилла A^H + C50^H (как в калибровке)
      const coup = st.env.growthKillCoupling; // β-лактам бьёт делящихся; фторхинолон — всех
      const kd0 = sp.kd;
      function curve(sat, style, color, wd) {
        c3.strokeStyle = color; c3.lineWidth = wd; c3.setLineDash(style); c3.beginPath();
        for (let k = 0; k <= 160; k++) {
          const lg = xLo + (xHi - xLo) * k / 160;
          const Av = Math.pow(10, lg);
          const AH = Math.pow(Av, sp.H);
          const kill = sp.kmax * AH / (AH + c50H);
          const net = sp.muMax * sat - kd0 - kill * (coup ? (0.2 + 0.8 * sat) : 1);
          const xx = X(lg), yy = Y(Math.max(yLo, Math.min(yHi, net)));
          if (k === 0) c3.moveTo(xx, yy); else c3.lineTo(xx, yy);
        }
        c3.stroke(); c3.setLineDash([]);
      }
      curve(1, [], sp.css, 1.8);                        // сытая зона (net=0 при A=MIC)
      if (s === 0 && coup) curve(0.05, [3, 3], 'rgba(125,146,173,.8)', 1.2); // голодная зона (wt, только β-лактам)
      c3.fillStyle = sp.css;
      c3.fillText(sp.name, X(Math.log10(Math.max(1e-3, sp.MIC))) + 4, Y(0) - 5 - s * 11);
    });
  }

  // ---------- панель видов ----------
  function buildSpeciesPanel() {
    const box = $('speciesList');
    let html = '';
    E.SPECIES.forEach(function (sp, i) {
      html += '<div class="sp-row" id="sprow-' + i + '">' +
        '<div class="sp-head" data-i="' + i + '" role="button" tabindex="0" aria-expanded="false">' +
        '<input type="checkbox" id="sp-en-' + i + '"' + (i < 1 ? ' checked' : '') + '>' +
        '<span class="sw" style="width:11px;height:11px;border-radius:3px;background:' + sp.css + ';display:inline-block"></span>' +
        '<label class="sp-name" for="sp-en-' + i + '">' + sp.name + '</label>' +
        '<span class="sp-count" id="sp-cnt-' + i + '">0</span></div>' +
        '<div class="sp-params">' +
        '<div class="kv"><label>\u03bcmax, ч\u207b\u00b9 (td ' + (Math.LN2 / sp.muMax * 60).toFixed(0) + ' мин)</label>' +
        '<input type="number" id="sp-mu-' + i + '" value="' + sp.muMax + '" step="0.1" min="0.1"></div>' +
        '<div class="kv"><label>MIC активного АБ, мг/л <span class="muted">(амоксициллин / энрофлоксацин)</span></label>' +
        '<input type="number" id="sp-mic-' + i + '" value="' + sp.MIC + '" step="' + (sp.MIC < 1 ? '0.01' : '1') + '" min="0.01"></div>' +
        '<div class="sp-note">' + sp.latin + ' · ' + sp.host + (sp.MIC2 ? ' · энро MIC ' + sp.MIC2 : '') + '</div>' +
        '</div></div>';
    });
    box.innerHTML = html;
    E.SPECIES.forEach(function (_, i) {
      const head = $('sprow-' + i).querySelector('.sp-head');
      head.addEventListener('click', function (ev) {
        if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'LABEL') return; // чекбокс и его label — не переключают панель
        const row = $('sprow-' + i);
        row.classList.toggle('open');
        head.setAttribute('aria-expanded', row.classList.contains('open') ? 'true' : 'false');
      });
      // Task 183: клавиатура — шапка вида как кнопка (Enter/Space раскрывают параметры)
      head.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); head.click(); }
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
      st.enabled[i] = false; // скрыть: из рендера/статистики; динамика вида приостановлена (заморожена в N), клетки вернутся при включении
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
    else if (tool.kind === 'drop') { E.dropAB(st, p.x, p.y, doseVal(), 5); logEvent('капля АБ ' + (doseVal() >= 10 ? doseVal().toFixed(0) : doseVal().toFixed(1)) + '\u00a0мг/л', 'man'); }
    else if (tool.kind === 'wipe') {
      const R = 5;
      for (let yy = Math.floor(p.y - R); yy <= p.y + R; yy++)
        for (let xx = Math.floor(p.x - R); xx <= p.x + R; xx++) {
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          if ((xx - p.x) * (xx - p.x) + (yy - p.y) * (yy - p.y) > R * R) continue;
          for (let s = 0; s < 4; s++) st.N[s][yy * W + xx] = 0;
        }
      logEvent('стёрты колонии.', 'man');
    }
    render(); updateLegend();
  }
  dish.addEventListener('pointerdown', function (ev) { dragging = true; applyTool(ev); });
  window.addEventListener('pointermove', function (ev) { if (dragging) applyTool(ev); });
  window.addEventListener('pointerup', function () { dragging = false; });
  // Task 183: тач — обрыв указателя (скролл-перехват и пр.) не должен залипать драг:
  // #dish { touch-action: none } не даёт браузеру забрать жест себе, pointercancel — страховка
  dish.addEventListener('pointercancel', function () { dragging = false; });

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
    let rows = '<b>A</b> ' + (st.A[i] >= 10 ? st.A[i].toFixed(0) : st.A[i].toFixed(1)) + '\u00a0мг/л (' +
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
      : kind === 'drop' ? 'Кликай по чаше — капля антибиотика ' + (doseVal() >= 10 ? doseVal().toFixed(0) : doseVal().toFixed(1)) + '\u00a0мг/л'
      : 'Кликай по чаше — стираешь колонии';
  }

  // ---------- тесты моделей ----------
  // Task 184: chunked-прогон — тесты из T.tests идут по одному в свой setTimeout: между
  // тестами браузер успевает перерисовать прогресс, кнопка «Прогнать заново» не подвешивает
  // страницу на весь синхронный прогон (node CLI гоняет тот же список через runAll).
  function runTests(cb) {
    const badge = $('modelBadge');
    badge.textContent = 'модели: проверка\u2026'; badge.className = 'badge';
    $('testsOut').innerHTML = '<div class="t-det">считаю\u2026</div>';
    const res = [];
    const fns = (T.tests || []).slice();
    (function next() {
      if (!fns.length) {
        const ok = res.filter(function (r) { return r.pass; }).length;
        badge.textContent = 'модели: ' + ok + '/' + res.length + (ok === res.length ? ' \u2713' : ' \u2717');
        badge.className = 'badge ' + (ok === res.length ? 'ok' : 'bad');
        if (cb) cb(ok, res.length);
        return;
      }
      setTimeout(function () {
        const f = fns.shift();
        let r;
        try { r = f(); } catch (e) { r = { name: f.name, pass: false, details: 'ошибка: ' + e.message }; }
        res.push(r);
        $('testsOut').innerHTML = res.map(function (r) {
          return '<div class="t-row"><div class="t-name ' + (r.pass ? 't-pass">PASS \u2713 ' : 't-fail">FAIL \u2717 ') +
            r.name + '</div><div class="t-det">' + r.details + '</div></div>';
        }).join('');
        badge.textContent = 'модели: ' + res.filter(function (r) { return r.pass; }).length + '/' + res.length + '\u2026';
        next();
      }, 0);
    })();
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
      kel: $('kel').value, pMut: $('pMut').value, S0: $('S0').value, pers: $('persMode').value,
      en: en, mu: mu, mic: mic, mode: $('doseMode').value, drug: $('drugMode') ? $('drugMode').value : 'amox' };
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
      if (hp.drug && E.DRUGS[hp.drug]) setDrugUI(hp.drug, false); // v1.4: класс АБ (до mic-оверрайда)
      if (hp.pers !== undefined && ['off', 'wt', 'hip'].indexOf(hp.pers) >= 0) $('persMode').value = hp.pers;
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
    // Task 183: клавиатура — .tool (инструменты посева/капли/ластика и слои чаши) как кнопки
    document.querySelectorAll('.tool').forEach(function (el) {
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); el.click(); }
      });
    });
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
    document.querySelectorAll('#layerBar .tool').forEach(function (b) {
      b.addEventListener('click', function () { setLayer(b.dataset.layer); render(); });
    });
    $('persMode').addEventListener('change', resetSim);
    $('drugMode').addEventListener('change', function () { setDrugUI(this.value, true); }); // v1.4: смена класса АБ
    $('btnLawn').addEventListener('click', function () { E.lawn(st, 0, 1e7); render(); updateLegend(); logEvent('газон E. coli по всей чаше', 'man'); });
    $('btnBolus').addEventListener('click', function () { E.bolusAB(st, doseVal()); render(); logEvent('болюс АБ ' + (doseVal() >= 10 ? doseVal().toFixed(0) : doseVal().toFixed(1)) + '\u00a0мг/л всю чашу', 'man'); });
    $('btnTests').addEventListener('click', function () { runTests(); });
    $('micTick').textContent = 'MIC ' + E.SPECIES[0].MIC;
    $('mpcTick').textContent = 'MPC ' + E.SPECIES[0].MIC * E.MPC_FACTOR;
    setDrugUI('amox', false);
    // Task 184: PD-профиль раскрывается (details) — перерисовать chart3 под фактическую ширину
    // (у закрытого details clientWidth = 0, буфер собирался каноническим 960px);
    // поворот экрана/ресайз — все канвы под новую ширину (при паузе loop их не перерисовывает)
    const emaxBox = document.querySelector('.emaxbox');
    if (emaxBox) emaxBox.addEventListener('toggle', function () { if (emaxBox.open) drawEmax(); });
    window.addEventListener('resize', function () { drawCharts(); drawEmax(); });

    applyPreset(0);
    if (location.hash && location.hash.length > 1) applyFromHash(); // ссылка-сценарий из методички
    requestAnimationFrame(loop);
    setTimeout(function () { runTests(); }, 400);
    setInterval(function () { if (st) { updateSpeciesCounts(); } }, 700);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
