/*
 * ВетПетри — движок симулятора чашки Петри (чистый модуль, без DOM).
 *
 * Слои модели (в порядке включения, как в учебной задаче):
 *   1) сетка с субстратом + диффузия (Нейман, явная схема)
 *   2) один вид: рост по Моно (μmax·S/(Ks+S)) с лаг-фазой по Бараньи–Робертс (q-функция)
 *      + локальная логистическая конкуренция за место (Nmax на ячейку)
 *   3) второй вид: та же динамика, общая ёмкость ячейки = эксплуатационная конкуренция
 *      (аналог Лотки–Вольтерры с общим ресурсом)
 *   4) антибиотик: диффузия + элиминация (kel), гибель по Хиллу/Emax (Regoes 2004 /
 *      Nielsen & Friberg 2006); C50 автокалибруется так, чтобы net-рост = 0 при A = MIC
 *      PK-режимы введения (одна суточная доза): болюс / 3 введения (q8h) / инфузия 24 ч
 *      — dose fractionation, цель для β-лактамов fT>MIC 40–70% (Berry 2022)
 *   4b) статические зоны АБ («мега-чаша», Baym 2016): полосы 0 → 1× → 10× → 100× MICwt
 *   5) мутации: поток wt→res при делении (p_mut на деление, демо-значение)
 *
 * Вход: параметры + seed (mulberry32). Выход: состояние (typed arrays) + статистика.
 * Фиксированный seed + фиксированный порядок обхода => воспроизводимый запуск.
 * Все новые слои (dosing, abZones) детерминированы: НЕ трогают поток rng() —
 * хэш прогона старых сценариев не меняется (проверено скриптом scripts/rng_check.js).
 *
 * Единицы: время — часы; S — мг/л (глюкоза, усл.); A — мг/л; N — КОЕ на ячейку сетки.
 * Ячейка сетки ~0.25 мм; локальная ёмкость Nmax = 1e8 КОЕ (калибровка, см. README).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.VetPetriEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- ГСЧ с фиксированным сидом (mulberry32) ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Виды (реальные вет. патогены, параметры — из литературы, см. README) ----------
  // muMax: 1/ч (37 °C, богатая среда); Ks: мг/л (Monod 1949 / Kovárová-Kovar & Egli 1998);
  // MIC: мг/л амоксициллина (CLSI/EUCAST; у Salmonella — прокси по ампициллину);
  // kd: скорость отмирания при истощении субстрата (порядок 0.05–0.15 1/ч);
  // kmax/H: фармакодинамика time-kill (Regoes 2004, Nielsen & Friberg 2006).
  const SPECIES_DEFAULTS = [
    {
      id: 'eco', name: 'E. coli', latin: 'Escherichia coli',
      host: 'телята, птица — колибактериоз',
      muMax: 2.1,   // td ≈ 20 мин (богатая среда, 37 °C)
      Ks: 4,        // Monod 1949: Ks глюкозы 2–6 мг/л
      MIC: 4,       // WT типично 2–8 мг/л (ECOFF ≤8)
      kd: 0.08,
      kmax: 3.0, H: 1.2, // β-лактамы: time-dependent, kmax ~2–4 1/ч
      color: [77, 208, 225], css: '#4dd0e1',
      resSource: -1, // не мутант
    },
    {
      id: 'sdu', name: 'Salmonella Dublin', latin: 'Salmonella enterica sv. Dublin',
      host: 'телята — септицемия, дизентерия',
      muMax: 1.4,   // td ≈ 30 мин
      Ks: 6,
      MIC: 4,       // прокси по ампициллину (CLSI S ≤8) — честная пометка
      kd: 0.08,
      kmax: 2.8, H: 1.2,
      color: [255, 183, 77], css: '#ffb74d',
      resSource: -1,
    },
    {
      id: 'pmu', name: 'P. multocida', latin: 'Pasteurella multocida',
      host: 'КРС — респираторный синдром, пастереллёз',
      muMax: 1.0,   // td ≈ 42 мин
      Ks: 6,
      MIC: 0.25,    // очень чувствителен (ампициллин S ≤0.5, CLSI vet)
      kd: 0.1,
      kmax: 3.0, H: 1.2,
      color: [174, 213, 129], css: '#aed581',
      resSource: -1,
    },
    {
      id: 'ecor', name: 'E. coli R (β-лактамаза)', latin: 'E. coli, TEM-тип',
      host: 'мутант E. coli с β-лактамазой (цена: рост −10%)',
      muMax: 1.9,   // фитнес-цена резистентности ~10%
      Ks: 4,
      MIC: 64,      // β-лактамаза (низкопродуцирующий TEM-вариант): ≥64 мг/л
      kd: 0.08,
      kmax: 3.0, H: 1.2,
      color: [240, 98, 146], css: '#f06292',
      resSource: 0, // мутант E. coli
    },
  ];

  // ---------- Параметры среды/антибиотика ----------
  const ENV_DEFAULTS = {
    S0: 1000,        // мг/л глюкозы в агаре (засев среды)
    Y: 1e5,          // выход: КОЕ на (мг/л · ячейку) — калибровка плато
    Nmax: 1e8,       // локальная ёмкость ячейки, КОЕ
    DS: 5.0,         // диффузия субстрата (эфф., усл.)
    DA: 3.5,         // диффузия антибиотика
    kel: 0.69,       // элиминация АБ, 1/ч (t½ ≈ 1 ч, КРС IM — Kreil 2012: 0.86±0.3)
    pMut: 1e-6,      // мутаций на деление wt→R (ДЕМО: завышено для наглядности)
    recycle: 0.9,    // доля биомассы, возвращаемая лизисом в субстрат (криптический рост)
    noise: 0.12,     // демографический шум (амплитуда), RNG от seed
    q0: 0.02,        // начальное физиологическое состояние (лаг-фаза, Бараньи)
    motility: 0.5,   // эффективная подвижность, ячейка²/ч — фронт колоний (Кольмогоров–Фишер)
    growthKillCoupling: true, // β-лактамы убивают делящиеся клетки
    // Персистеры (v1.3, Balaban 2004, Science 305:1622; значения a/b сведены в
    // Kussell & Leibler 2005, Genetics 169:1807): дормантный компартмент n↔p.
    // WT: a = 1.2e-6 1/ч, b = 0.1 1/ч; hipQ: a = 1e-3 1/ч, b = 1e-6…1e-4 (взято 1e-4,
    // в статье «poorly determined»). persA = 0 — слой ВЫКЛЮЧЕН (детерминированно,
    // без rng; хэши старых сценариев не меняются).
    persA: 0,
    persB: 0.1,
  };

  const MPC_FACTOR = 8; // MPC ≈ 8×MIC (Drlica & Zhao 2003/2007; для β-лактамов — оценка)

  // ---------- Конструктор состояния ----------
  function createState(cfg) {
    const W = cfg.W | 0, H = cfg.H | 0;
    const n = W * H;
    const species = cfg.species.map(function (s) { return Object.assign({}, s); });
    const env = Object.assign({}, ENV_DEFAULTS, cfg.env || {});
    const st = {
      W: W, H: H, n: n,
      species: species,
      env: env,
      enabled: cfg.enabled.map(function (x) { return !!x; }),
      S: new Float32Array(n), A: new Float32Array(n),
      N: species.map(function () { return new Float32Array(n); }),
      P: species.map(function () { return new Float32Array(n); }), // персистеры (v1.3, дормант)
      q: species.map(function () { return env.q0; }), // Бараньи q, глобально на вид
      t: 0,
      cx: (W - 1) / 2, cy: (H - 1) / 2,
      R: Math.min(W, H) / 2 - 1.5,  // радиус чашки в ячейках
      seed: cfg.seed >>> 0,
      _rng: null, _tmpS: new Float32Array(n), _tmpA: new Float32Array(n),
      _wellMixed: !!cfg.wellMixed, // 0D-режим для тестов time-kill (без диффузии)
      mask: null, // 1 = внутри чашки (для обнуления N вне чашки после дисперсии)
      // PK-режим введения (v1.1): 'bolus' | 'q8h' | 'infusion'; dose — суточная доза, мг/л
      dosing: { mode: (cfg.dosing && cfg.dosing.mode) || 'bolus', dose: (cfg.dosing && cfg.dosing.dose) || 0 },
      _nextDoseT: 8, // время следующего долива в режиме q8h (болюсы в 0, 8, 16 ч)
    };
    st._rng = mulberry32(st.seed);
    st._pers = env.persA > 0; // слой персистеров включён (детерминированный, без rng)
    // статические полосы АБ («мега-чаша», Baym 2016): доли диаметра чашки [f0..f1]
    if (cfg.abZones && cfg.abZones.length) {
      const mic0 = Math.max(0.01, species[0].MIC);
      st.abZones = cfg.abZones.map(function (z) { return { f0: z.f0, f1: z.f1, conc: (z.mult || 0) * mic0 }; });
      st._zoneCol = new Float32Array(W); // концентрация по колонкам — детерминированный ландшафт
      for (let x = 0; x < W; x++) {
        const f = (x - (st.cx - st.R)) / (2 * st.R);
        let c = 0;
        for (let z = 0; z < st.abZones.length; z++) {
          const zn = st.abZones[z];
          if (f >= zn.f0 && (f < zn.f1 || (zn.f1 >= 1 && f <= 1.05))) { c = zn.conc; break; }
        }
        st._zoneCol[x] = c;
      }
    } else { st.abZones = null; st._zoneCol = null; }
    // среда: субстрат везде в чашке, вне чашки — 0
    st.mask = new Uint8Array(n);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const ins = inside(st, x, y);
        st.mask[i] = ins ? 1 : 0;
        st.S[i] = ins ? env.S0 : 0;
        // в мега-чаше антибиотик уже в агаре в момент посева (детерминированно, без rng)
        st.A[i] = (st.abZones && ins) ? st._zoneCol[x] : 0;
      }
    }
    return st;
  }

  function inside(st, x, y) {
    const dx = x - st.cx, dy = y - st.cy;
    return dx * dx + dy * dy <= st.R * st.R;
  }

  // C50 (концентрация полумаксимальной гибели) из MIC: net-рост = 0 при A = MIC
  // g − kd = kmax·MIC^H/(MIC^H + C50^H)  =>  C50 = MIC·(kmax/g − 1)^(1/H)
  function c50Of(sp, env) {
    const g = Math.max(0.2, sp.muMax - sp.kd);
    if (sp.kmax <= g) return sp.MIC * 1e3; // kill слабее роста — MIC не достигается
    return sp.MIC * Math.pow(sp.kmax / g - 1, 1 / sp.H);
  }

  // ---------- Инокуляция / инструменты ----------
  // blob: гауссова капля вида s в (x,y), total CFU, радиус r ячеек
  function inoculate(st, s, x, y, totalCfu, r) {
    const N = st.N[s];
    const r2 = r * r; let wsum = 0;
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(st.W - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(st.H - 1, Math.ceil(y + r));
    const w = [];
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const d2 = (xx - x) * (xx - x) + (yy - y) * (yy - y);
      if (d2 > r2 || !inside(st, xx, yy)) continue;
      const wv = Math.exp(-d2 / (r2 / 2)); w.push(yy * st.W + xx); w.push(wv); wsum += wv;
    }
    if (wsum <= 0) return;
    for (let k = 0; k < w.length; k += 2) N[w[k]] += totalCfu * w[k + 1] / wsum;
    st.q[s] = Math.max(st.q[s], st.env.q0);
  }

  // газон: равномерный засев всей чашки
  function lawn(st, s, totalCfu) {
    let area = 0;
    for (let i = 0; i < st.n; i++) if (st.S[i] > 0) area++;
    const per = totalCfu / area;
    for (let i = 0; i < st.n; i++) if (st.S[i] > 0) st.N[s][i] += per;
  }

  // полосной газон: равномерный засев вертикальной полосы x∈[fx0..fx1] (доли диаметра)
  function lawnStrip(st, s, fx0, fx1, totalCfu) {
    const x0 = st.cx - st.R + fx0 * 2 * st.R, x1 = st.cx - st.R + fx1 * 2 * st.R;
    let cells = 0;
    for (let y = 0; y < st.H; y++)
      for (let x = Math.max(0, Math.ceil(x0 - 0.5)); x <= Math.min(st.W - 1, Math.floor(x1 + 0.5)); x++)
        if (st.mask[y * st.W + x]) cells++;
    if (!cells) return;
    const per = totalCfu / cells;
    for (let y = 0; y < st.H; y++)
      for (let x = Math.max(0, Math.ceil(x0 - 0.5)); x <= Math.min(st.W - 1, Math.floor(x1 + 0.5)); x++)
        if (st.mask[y * st.W + x]) st.N[s][y * st.W + x] += per;
  }

  // начальное внесение дозы по PK-режиму (вызывается из setup пресета)
  function initDose(st) {
    if (st.abZones) return; // в мега-чаше концентрации задают полосы
    if (st.dosing.mode === 'bolus') bolusAB(st, st.dosing.dose);
    else if (st.dosing.mode === 'q8h') bolusAB(st, st.dosing.dose / 3); // первая из трёх
    // infusion: поток добавляется в step() (rate = dose/24)
  }

  // капля антибиотика (гаусс), total — мг/л в пике (нормируем на пик)
  function dropAB(st, x, y, peak, r) {
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(st.W - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(st.H - 1, Math.ceil(y + r));
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const i = yy * st.W + xx;
      if (!st.S[i] && st.A[i] === 0) { /* вне чашки не держим */ }
      const d2 = (xx - x) * (xx - x) + (yy - y) * (yy - y);
      if (d2 > r2) continue;
      st.A[i] = Math.max(st.A[i], peak * Math.exp(-d2 / (r2 / 2)));
    }
  }

  // болюс: мгновенно всю чашку до концентрации dose
  function bolusAB(st, dose) {
    for (let i = 0; i < st.n; i++) if (st.S[i] > 0 || st.A[i] > 0) st.A[i] = Math.max(st.A[i], dose);
  }

  // ---------- Диффузия (явная схема, Нейман — без потока через край) ----------
  function diffuse(arr, tmp, W, H, D, dt, sub) {
    const d = D * dt / sub;
    if (d * 4 > 0.45) throw new Error('diffusion unstable: ' + d);
    for (let s = 0; s < sub; s++) {
      tmp.set(arr);
      for (let y = 0; y < H; y++) {
        const yn = y > 0 ? y - 1 : 0, yp = y < H - 1 ? y + 1 : H - 1;
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const xn = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : W - 1;
          const lap = tmp[yn * W + x] + tmp[yp * W + x] + tmp[y * W + xn] + tmp[y * W + xp] - 4 * tmp[i];
          arr[i] = tmp[i] + d * lap;
        }
      }
    }
  }

  // ---------- Один шаг по времени (dt, ч) ----------
  function step(st, dt) {
    const env = st.env, W = st.W, H = st.H, n = st.n;
    const rng = st._rng;

    // 1) диффузия субстрата и антибиотика (в мега-чаше A статичен — диффузия/элиминация не нужны)
    if (!st._wellMixed) {
      const subS = Math.max(1, Math.ceil(env.DS * dt / 0.11));
      diffuse(st.S, st._tmpS, W, H, env.DS, dt, subS);
      if (!st.abZones) {
        const subA = Math.max(1, Math.ceil(env.DA * dt / 0.11));
        diffuse(st.A, st._tmpA, W, H, env.DA, dt, subA);
      }
    }

    // 2) антибиотик: статические полосы (Baym 2016) ИЛИ PK: q8h-доливы + элиминация/инфузия
    if (st.abZones) {
      const zc = st._zoneCol;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) st.A[row + x] = st.mask[row + x] ? zc[x] : 0;
      }
    } else {
      if (st.dosing.mode === 'q8h' && st.t + 1e-6 >= st._nextDoseT) {
        bolusAB(st, st.dosing.dose / 3); // та же суточная доза, но тремя болюсами
        st._nextDoseT += 8;
      }
      const dec = Math.exp(-env.kel * dt);
      if (st.dosing.mode === 'infusion') {
        // dA/dt = rate − kel·A; rate = суточная доза / 24 → A_ss = rate/kel.
        // ВАЖНО: льём только внутрь чашки (по mask) — иначе stats() завышает среднее
        // в n/area раз (грабля v1.1, поймана тестом Т5).
        const rate = st.dosing.dose / 24;
        if (env.kel > 0) {
          const add = rate / env.kel * (1 - dec);
          for (let i = 0; i < n; i++) st.A[i] = st.mask[i] ? st.A[i] * dec + add : 0;
        } else {
          for (let i = 0; i < n; i++) if (st.mask[i]) st.A[i] += rate * dt; // t½→∞: честный линейный подъём
        }
      } else if (env.kel > 0) {
        for (let i = 0; i < n; i++) st.A[i] *= dec;
      }
    }

    // 3) среднее по чашке (для глобального q — упрощение Бараньи, помечено в README)
    let sSum = 0, area = 0;
    for (let i = 0; i < n; i++) if (st.S[i] > 0) { sSum += st.S[i]; area++; }
    const sMean = area > 0 ? sSum / area : 0;

    // 4) рост/гибель по видам
    const Nmax = env.Nmax, Y = env.Y;
    const c50 = st._c50 || (st._c50 = st.species.map(function (sp) { return c50Of(sp, env); }));
    const newQ = st.q.slice();
    for (let s = 0; s < st.species.length; s++) {
      if (!st.enabled[s]) continue;
      const sp = st.species[s];
      const N = st.N[s];
      const muS = sp.muMax * sMean / (sp.Ks + sMean);        // Моно от среднего S (для q)
      newQ[s] = st.q[s] * (1 + muS * dt);                    // dq/dt = μ(S)·q
      const lagF = st.q[s] / (1 + st.q[s]);                  // q/(1+q): лаг-фаза
      const c50s = c50[s], Hs = sp.H;

      for (let i = 0; i < n; i++) {
        const Si = st.S[i];
        if (Si <= 0 && N[i] <= 0) continue;
        const Ni = N[i];
        if (Ni <= 0) continue;

        // локальный рост: Моно × Бараньи × логистика (общая ёмкость ячейки)
        let Ntot = 0;
        for (let k = 0; k < st.N.length; k++) if (st.enabled[k]) Ntot += st.N[k][i];
        const crow = 1 - Ntot / Nmax;
        const g = crow <= 0 ? 0
          : sp.muMax * lagF * (Si / (sp.Ks + Si)) * crow;    // 1/ч

        // демографический шум (seed-воспроизводимый)
        let gg = g;
        if (env.noise > 0) gg *= 1 + env.noise * (rng() * 2 - 1);
        if (gg < 0) gg = 0;

        // гибель от антибиотика: Хилл/Emax; β-лактамы — по делящимся клеткам
        // (связь с локальным субстратом: в голодных зонах убивают слабее — «персистеры»)
        let kill = sp.kmax * Math.pow(st.A[i], Hs) / (Math.pow(st.A[i], Hs) + c50s);
        if (env.growthKillCoupling) kill *= 0.2 + 0.8 * (Si / (sp.Ks + Si));

        const deaths = (kill + sp.kd) * Ni * dt;
        let dN = gg * Ni * dt - deaths;
        // мутация: поток wt → R при делении
        if (sp.resSource < 0 && st.enabled[3] && st.species[3].resSource === s && env.pMut > 0 && gg > 0) {
          const dRes = gg * Ni * env.pMut * dt;
          st.N[3][i] += dRes;
          dN -= dRes;
        }
        N[i] += dN;
        // порог вымирания; при включённых персистерах ячейка жива, пока есть дормант
        // (иначе порог съедает выходящих из дорманта — они возвращаются каплями < порога)
        if (N[i] < 1e-2 && !(st._pers && st.P[s][i] > 0)) N[i] = 0;
        // лизис возвращает часть биомассы в субстрат (криптический рост):
        // иначе получается перелёт и обвал вместо плато + медленного отмирания
        if (deaths > 0) st.S[i] = Math.min(st.env.S0, st.S[i] + env.recycle * deaths / Y);
        if (gg > 0) st.S[i] = Math.max(0, st.S[i] - (gg * Ni / Y) * dt);
      }
    }
    st.q = newQ;

    // 4b) персистеры (v1.3, Balaban 2004): дормантный пул — детерминированно, БЕЗ rng.
    // β-лактам бьёт делящиеся: дормант не растёт, не двигается, не ест и не гибнет.
    // n → p со скоростью a (спонтанный переход), p → n со скоростью b (выход из
    // дорманта, 1/b — «лаг» персистеров). Включается только при env.persA > 0,
    // поэтому поток rng() и хэши сценариев по умолчанию не тронуты.
    if (env.persA > 0) {
      for (let s = 0; s < st.species.length; s++) {
        if (!st.enabled[s]) continue;
        const Ns = st.N[s], Ps = st.P[s];
        for (let i = 0; i < n; i++) {
          const ni = Ns[i];
          if (ni > 0) {
            const sw = ni * env.persA * dt;      // n → p
            Ns[i] = ni - sw; Ps[i] += sw;
          }
          if (Ps[i] > 0) {
            const back = Ps[i] * env.persB * dt; // p → n
            Ps[i] -= back; Ns[i] += back;
          }
        }
      }
    }

    // 5) дисперсия клеток (подвижность): фронт колоний расползается (Кольмогоров–Фишер)
    if (!st._wellMixed && env.motility > 0) {
      const dN = env.motility * dt; // ≤ 0.11 — устойчиво
      if (dN * 4 > 0.45) throw new Error('motility unstable: ' + dN);
      for (let s = 0; s < st.species.length; s++) {
        if (!st.enabled[s]) continue;
        diffuse(st.N[s], st._tmpS, W, H, env.motility, dt, 1);
        const Ns = st.N[s];
        for (let i = 0; i < n; i++) if (!st.mask[i]) Ns[i] = 0; // не выходим за чашку
      }
    }

    st.t += dt;
  }

  // ---------- Статистика ----------
  function stats(st) {
    const out = { t: st.t, totals: new Array(st.species.length).fill(0), S: 0, A: 0, Amax: 0, area: 0, pers: 0 };
    const hasP = !!st._pers;
    for (let i = 0; i < st.n; i++) {
      if (st.S[i] > 0) { out.area++; out.S += st.S[i]; }
      if (st.A[i] > out.Amax) out.Amax = st.A[i];
      out.A += st.A[i];
      for (let s = 0; s < st.species.length; s++) {
        out.totals[s] += hasP ? st.N[s][i] + st.P[s][i] : st.N[s][i];
        if (hasP) out.pers += st.P[s][i];
      }
    }
    out.S /= (out.area || 1); out.A /= (out.area || 1);
    const wt = out.totals[0] || 0, res = out.totals[3] || 0;
    out.resFrac = (wt + res) > 0 ? res / (wt + res) : 0;
    return out;
  }

  function hashState(st) { // воспроизводимость: числовой хэш состояния
    let h = 2166136261 >>> 0;
    function mix(v) {
      const x = Math.round(v * 1e6) | 0;
      h = (Math.imul(h ^ x, 16777619)) >>> 0;
    }
    for (let i = 0; i < st.n; i += 7) {
      mix(st.S[i]);
      for (let s = 0; s < st.N.length; s++) mix(st.N[s][i]);
    }
    return h.toString(16);
  }

  // ---------- экспорт данных и URL-hash (чистые функции, тестируются в node) ----------
  function buildCSV(history) {
    const names = ['eco', 'sdu', 'pmu', 'ecor'];
    const head = ['t_h', 'S_mg_l', 'A_mg_l'].concat(names.map(function (n) { return 'N_' + n; })).join(';');
    const rows = history.map(function (p) {
      return [p.t.toFixed(2), p.S.toPrecision(6), p.A.toPrecision(6)]
        .concat(p.tot.map(function (v) { return v.toExponential(5); })).join(';');
    });
    return [head].concat(rows).join('\n');
  }

  function serializeParams(obj) {
    return Object.keys(obj).map(function (k) { return k + '=' + encodeURIComponent(obj[k]); }).join('&');
  }

  function parseParams(s) {
    const out = {};
    if (!s) return out;
    s.replace(/^#/, '').split('&').forEach(function (kv) {
      const i = kv.indexOf('=');
      if (i > 0) out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    });
    return out;
  }

  // ---------- Хроника событий (v1.2): детектор заметных событий по шагам stats ----------
  // Чистая функция БЕЗ rng (поток ГСЧ не трогаем — воспроизводимость не меняется).
  // UI/тесты вызывают chronicleStep() после каждого stats(); fl — накопитель на прогон.
  // Классы событий: gr рост/субстрат, ab антибиотик, mut мутанты, warn гибель, man ручные.
  function chronFlags() {
    return { n0: null, r0: 0, lag: false, s5: false, s05: false, abUp: false, abDown: false,
      mut0: false, mutHalf: false, kill1: false, kill3: false, regrow: false,
      persSurv: false, persWake: false, persMax: 0,
      peak: 0, trough: Infinity, band: 0 };
  }

  // полоса мега-чаши z (1..3) колонизована R (плотно, >1e6 КОЕ на ячейку)?
  function rBandOccupied(st, z) {
    if (!st.abZones || !st.N[3]) return false;
    const zn = st.abZones[z];
    const x0 = Math.max(0, Math.ceil(st.cx - st.R + zn.f0 * 2 * st.R));
    const x1 = Math.min(st.W - 1, Math.floor(st.cx - st.R + zn.f1 * 2 * st.R));
    const N3 = st.N[3];
    for (let x = x0; x <= x1; x++)
      for (let y = 0; y < st.H; y += 2)
        if (N3[y * st.W + x] > 1e6) return true;
    return false;
  }

  function chronicleStep(st, s, fl) {
    const out = [];
    const tot = s.tot || s.totals, t = s.t; // s — запись истории (tot) или вывод stats() (totals)
    const total = tot[0] + tot[1] + tot[2] + tot[3];
    if (fl.n0 === null) { fl.n0 = total; fl.r0 = tot[3]; } // первый замер: посев
    // прогон, начавшийся с пустой чаши (песочница): база перезакрепляется после первого посева
    if (fl.n0 <= 100 && total > 1000) { fl.n0 = total; fl.r0 = Math.max(fl.r0, tot[3]); }
    // лаг → экспонента: суммарная биомасса утроилась
    if (!fl.lag && fl.n0 > 100 && total > fl.n0 * 2.5 && t > 0.2) {
      fl.lag = true;
      out.push({ t: t, txt: 'лаг-фаза позади — пошёл экспоненциальный рост', cls: 'gr' });
    }
    // субстрат
    const sf = s.S / st.env.S0;
    if (!fl.s5 && sf < 0.05) {
      fl.s5 = true;
      out.push({ t: t, txt: 'субстрат на исходе (<5% S\u2080) — рост замедляется', cls: 'gr' });
    }
    if (!fl.s05 && sf < 0.005) {
      fl.s05 = true;
      out.push({ t: t, txt: 'субстрат исчерпан — стационарная фаза', cls: 'gr' });
    }
    // пик/гибель/регроу
    if (total > fl.peak) { fl.peak = total; fl.trough = Infinity; }
    if (!fl.kill1 && fl.peak > 1e4 && total < fl.peak / 10 && t > 0.5) {
      fl.kill1 = true; fl.trough = total;
      out.push({ t: t, txt: 'массовая гибель: \u22121 log\u2081\u2080 от пика', cls: 'warn' });
    }
    if (!fl.kill3 && fl.kill1 && total < fl.peak / 1000) {
      fl.kill3 = true;
      out.push({ t: t, txt: 'массовая гибель: \u22123 log\u2081\u2080 от пика', cls: 'warn' });
    }
    if (fl.kill1) {
      if (total < fl.trough) fl.trough = total;
      if (!fl.regrow && fl.trough > 0 && total > fl.trough * 4 && s.A < st.species[0].MIC) {
        fl.regrow = true;
        out.push({ t: t, txt: 'регроу: выжившие отрастают (АБ упал ниже MIC)', cls: 'gr' });
      }
    }
    // антибиотик (среднее по чашке; в мега-чаше вместо этого — фронты R по полосам)
    if (!st.abZones) {
      const mic = st.species[0].MIC;
      if (!fl.abUp && s.A > mic) {
        fl.abUp = true;
        out.push({ t: t, txt: 'АБ > MICwt — началась гибель клеток', cls: 'ab' });
      } else if (fl.abUp && !fl.abDown && s.A < mic) {
        fl.abDown = true;
        out.push({ t: t, txt: 'АБ < MICwt — окно для регроу открыто', cls: 'ab' });
      }
    } else {
      for (let z = fl.band + 1; z < st.abZones.length; z++) {
        if (rBandOccupied(st, z)) {
          fl.band = z;
          out.push({ t: t, txt: 'R-фронт вошёл в полосу ' + (z === 1 ? '1\u00d7MIC' : z === 2 ? '10\u00d7MIC' : '100\u00d7MIC'), cls: 'mut' });
        } else break;
      }
    }
    // персистеры (v1.3, Balaban 2004): дормантный резервуар пережил АБ + выход из дорманта
    if (st.env.persA > 0) {
      const mic0 = st.species[0].MIC, pers = s.pers || 0;
      if (pers > fl.persMax) fl.persMax = pers;
      if (!fl.persSurv && s.A > mic0 && pers > 50 && total < fl.peak / 10) {
        fl.persSurv = true;
        out.push({ t: t, txt: 'персистеры пережили АБ — дормантный резервуар ≈ ' + pers.toExponential(1) + ' КОЕ', cls: 'pers' });
      }
      if (fl.persSurv && !fl.persWake && s.A < mic0) {
        fl.persWake = true;
        out.push({ t: t, txt: 'АБ упал — персистеры выходят из дорманта (1/b ≈ ' + (1 / st.env.persB).toFixed(0) + ' ч)', cls: 'pers' });
      }
    }
    // мутанты: родились сами (r0 < 1 — R не сеяли) и вытеснили wt
    if (!fl.mut0 && fl.r0 < 1 && tot[3] > 100) {
      fl.mut0 = true;
      out.push({ t: t, txt: 'родился первый мутант (β-лактамаза, MIC 64)', cls: 'mut' });
    }
    if (!fl.mutHalf && fl.r0 < 1 && (tot[0] + tot[3]) > 1e4 && tot[3] / (tot[0] + tot[3]) > 0.5) {
      fl.mutHalf = true;
      out.push({ t: t, txt: 'мутанты вытеснили wt (>50% популяции)', cls: 'mut' });
    }
    return out;
  }

  return {
    mulberry32: mulberry32,
    SPECIES: SPECIES_DEFAULTS,
    ENV: ENV_DEFAULTS,
    MPC_FACTOR: MPC_FACTOR,
    c50Of: c50Of,
    createState: createState,
    inside: inside,
    inoculate: inoculate,
    lawn: lawn,
    lawnStrip: lawnStrip,
    dropAB: dropAB,
    bolusAB: bolusAB,
    initDose: initDose,
    step: step,
    stats: stats,
    hashState: hashState,
    buildCSV: buildCSV,
    serializeParams: serializeParams,
    parseParams: parseParams,
    chronFlags: chronFlags,
    chronicleStep: chronicleStep,
  };
});
