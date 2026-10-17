/*
 * ВетПетри — тесты моделей на известных кривых (0D/малая сетка, без DOM).
 * Гоняются в node (node src/tests.js) и в браузере (панель «Тесты моделей»).
 * Каждый тест возвращает {name, pass, details}.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./engine.js'));
  else root.VetPetriTests = factory(root.VetPetriEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  function mk(cfg) {
    return E.createState(Object.assign({
      W: 20, H: 12, seed: 42,
      species: E.SPECIES,
      enabled: [true, false, false, false],
      wellMixed: true,
    }, cfg));
  }

  // Т1. S-образная кривая роста (Моно + Бараньи): лаг → экспонента → плато,
  //     баланс массы: прирост ≈ Y·израсходованный субстрат.
  function testGrowth() {
    const st = mk({ env: { noise: 0 } });
    const area = (function () { let a = 0; for (let i = 0; i < st.n; i++) if (st.S[i] > 0) a++; return a; })();
    E.lawn(st, 0, 1e6); // N0 = 1e6 КОЕ суммарно
    const cap = area * st.env.Nmax; // = area·S0·Y при S0=1000, Y=1e5
    let t2x = null, peak = 0;
    while (st.t < 24) {
      E.step(st, 0.02);
      const tot = E.stats(st).totals[0];
      if (t2x === null && tot >= 2e6) t2x = st.t;
      if (tot > peak) peak = tot;
    }
    const fin = E.stats(st).totals[0];
    const plateauOk = peak > cap * 0.7 && fin > cap * 0.5; // плато ≈ выходу Y·S0, отмирание медленное
    const lagOk = t2x !== null && t2x > 0.8; // без лаг-фазы было бы ~0.33 ч
    const sLeft = E.stats(st).S;
    return {
      name: 'S-кривая роста (лаг/экспонента/плато/отмирание, баланс массы)',
      pass: plateauOk && lagOk && sLeft < st.env.S0 * 0.05,
      details: 'N0=1e6 → пик ' + peak.toExponential(2) + ', финал(24ч) ' + fin.toExponential(2) +
        ' (ёмкость ' + cap.toExponential(2) + '), лаг до ×2 = ' + (t2x || -1).toFixed(2) + ' ч' +
        ', субстрат остаток ' + (sLeft / st.env.S0 * 100).toFixed(1) + '%',
    };
  }

  // Т2. Time-kill (Хилл/Emax): C >> MIC — лог-линейная гибель; C << MIC — рост.
  function testTimeKill() {
    function run(dose) {
      const st = mk({ env: { noise: 0, kel: 0 } }); // устойчивая концентрация
      E.lawn(st, 0, 1e6);
      if (dose > 0) E.bolusAB(st, dose);
      const n0 = 1e6; let n6 = null;
      while (st.t < 6) { E.step(st, 0.01); }
      n6 = E.stats(st).totals[0];
      return Math.log10(n6 / n0) / 6; // log10(КОЕ)/ч
    }
    const slopeHi = run(10 * 4);   // 10×MIC = 40 мг/л
    const slopeLo = run(0.1 * 4);  // 0.1×MIC
    const killOk = slopeHi < -0.3; // β-лактам: быстрый лог-линейный спад
    const growOk = slopeLo > 0.05;
    return {
      name: 'Time-kill по Хиллу: 10×MIC убивает, 0.1×MIC растёт',
      pass: killOk && growOk,
      details: 'наклон при 40 мг/л: ' + slopeHi.toFixed(2) + ' log10/ч; при 0.4 мг/л: ' + slopeLo.toFixed(2) + ' log10/ч',
    };
  }

  // Т3. Воспроизводимость: одинаковый seed → идентичное состояние; разный → различие.
  function testSeed() {
    function run(seed) {
      const st = mk({
        W: 24, H: 14, seed: seed, wellMixed: false,
        enabled: [true, false, false, true],
        env: { noise: 0.3, pMut: 1e-5, kel: 0.5 },
      });
      E.lawn(st, 0, 1e7);
      E.inoculate(st, 3, st.cx, st.cy - 3, 1e4, 3);
      E.bolusAB(st, 6);
      for (let k = 0; k < 150; k++) E.step(st, 0.05);
      return E.hashState(st);
    }
    const a = run(777), b = run(777), c = run(778);
    return {
      name: 'Воспроизводимость (фиксированный seed)',
      pass: a === b && a !== c,
      details: 'seed 777: ' + a + ' == seed 777: ' + b + ', seed 778: ' + c + ' отличается: ' + (a !== c),
    };
  }

  // Т4. Окно селекции мутантов (Drlica): MICwt=4, MPC=32, MICres=64.
  //     Доза в окне (8) → резистентные вытесняют; доза >MPCres (256) → оба подавлены;
  //     доза < MICwt (0.5) → растут оба.
  function testSelectionWindow() {
    function run(dose) {
      const st = mk({
        seed: 9, enabled: [true, false, false, true],
        env: { noise: 0, kel: 0, pMut: 0 },
      });
      E.lawn(st, 0, 1e6);
      E.lawn(st, 3, 1e4); // 1% резистентных
      if (dose > 0) E.bolusAB(st, dose);
      while (st.t < 20) E.step(st, 0.05);
      const s = E.stats(st);
      return { wt: s.totals[0], res: s.totals[3], frac: s.resFrac };
    }
    const lo = run(0.5), win = run(8), hi = run(256);
    const growBoth = lo.wt > 1e6 && lo.res > 1e4;              // ниже MICwt растут оба
    const resWins = win.frac > 0.9 && win.res > 10 * 1e4;      // в окне R доминирует
    const hiKills = hi.wt < 0.1 * 1e6 && hi.res < 0.1 * 1e4;    // выше MPC подавлены оба
    return {
      name: 'Окно селекции: 8 мг/л (в окне) → R вытесняет wt; 256 мг/л (>MPC) → оба подавлены',
      pass: growBoth && resWins && hiKills,
      details: '0.5 мг/л: wt ' + lo.wt.toExponential(1) + ', R ' + lo.res.toExponential(1) +
        '; 8 мг/л: доля R ' + (win.frac * 100).toFixed(1) + '%; 256 мг/л: wt ' + hi.wt.toExponential(1) +
        ', R ' + hi.res.toExponential(1),
    };
  }

  // Т5. PK-режимы введения (dose fractionation): инфузия той же суточной дозой
  //     выходит на стационар A_ss = rate/kel и держит его (±10%); T>MIC (с 6 ч) = 100%;
  //     болюс той же дозы держит A>MIC заметно меньше (в деталях).
  function testInfusion() {
    const kel = 0.69, Ass = 6;             // цель: стационар 6 мг/л (1.5×MICwt)
    const D = Ass * 24 * kel;              // суточная доза → rate/kel = Ass
    function run(mode) {
      const st = mk({ seed: 5, enabled: [true, false, false, false],
        dosing: { mode: mode, dose: D }, env: { noise: 0, kel: kel } });
      E.lawn(st, 0, 1e6);
      E.initDose(st); // вносим дозу по режиму (болюс/первая доза q8h; инфузия — потоком в step)
      let above = 0, n = 0, minA = 1e9, maxA = -1, aboveAll = 0, nAll = 0;
      while (st.t < 24) {
        E.step(st, 0.05);
        const s = E.stats(st);
        nAll++; if (s.A > st.species[0].MIC) aboveAll++;
        if (st.t >= 12) { minA = Math.min(minA, s.A); maxA = Math.max(maxA, s.A); }
        if (st.t >= 6) { n++; if (s.A > st.species[0].MIC) above++; }
      }
      return { tmic: above / n, minA: minA, maxA: maxA, tmicAll: aboveAll / nAll };
    }
    const inf = run('infusion'), bol = run('bolus');
    const steadyOk = inf.minA > Ass * 0.9 && inf.maxA < Ass * 1.1;
    return {
      name: 'PK-режимы: инфузия держит A≈A_ss (±10%) и T>MIC=100% (с 6 ч); болюс — вдвое-втрое меньше',
      pass: steadyOk && inf.tmic === 1 && bol.tmic < 0.5,
      details: 'инфузия D=' + D.toFixed(0) + ' мг/л: A(12–24 ч) ' + inf.minA.toFixed(2) + '–' + inf.maxA.toFixed(2) +
        ', T>MIC ' + (inf.tmicAll * 100).toFixed(0) + '% всех суток (100% после выхода на плато); болюс той же дозы: T>MIC ' +
        (bol.tmicAll * 100).toFixed(0) + '%',
    };
  }

  // Т6. Мега-чаша (Baym 2016, Science): полосы 0 → 1× → 10× → 100× MIC.
  //     R-клон прорывает полосу 1×MIC (появляется и растёт в полосе 10×) за ≤36 ч;
  //     wt за 72 ч не пересекает полосу 10× (в полосе 100× его нет).
  function testMegaPlate() {
    function zoneCount(st, sp, f0, f1) {
      const x0 = st.cx - st.R + f0 * 2 * st.R, x1 = st.cx - st.R + f1 * 2 * st.R;
      const N = st.N[sp]; let sum = 0;
      for (let y = 0; y < st.H; y++)
        for (let x = Math.max(0, Math.ceil(x0 - 0.5)); x <= Math.min(st.W - 1, Math.floor(x1 + 0.5)); x++) {
          const f = (x - (st.cx - st.R)) / (2 * st.R);
          if (f >= f0 && (f < f1 || (f1 >= 1 && f <= 1.05))) sum += N[y * st.W + x];
        }
      return sum;
    }
    function run(seed) {
      const st = mk({ W: 64, H: 24, seed: seed, wellMixed: false,
        enabled: [true, false, false, true], env: { noise: 0, kel: 0, pMut: 1e-6 },
        abZones: [{ f0: 0, f1: 0.25, mult: 0 }, { f0: 0.25, f1: 0.5, mult: 1 },
                  { f0: 0.5, f1: 0.75, mult: 10 }, { f0: 0.75, f1: 1, mult: 100 }] });
      E.lawnStrip(st, 0, 0, 0.24, 2e6);                          // газон wt в нулевой зоне
      E.inoculate(st, 3, st.cx - st.R * 0.8, st.cy, 1e4, 2);     // R-клон слева
      let crossT = null, wtHi = 0;
      while (st.t < 72) {
        E.step(st, 0.05);
        if (Math.abs(st.t / 2 - Math.round(st.t / 2)) < 1e-9) {  // каждые 2 ч
          if (crossT === null && zoneCount(st, 3, 0.5, 0.75) > 1e3) crossT = st.t;
          wtHi = zoneCount(st, 0, 0.75, 1);
        }
      }
      return { crossT: crossT, wtHi: wtHi };
    }
    const seeds = [42, 43, 44];
    const runs = seeds.map(run);
    const ok = runs.every(function (r) { return r.crossT !== null && r.crossT <= 36 && r.wtHi < 100; });
    return {
      name: 'Мега-чаша (Baym 2016): R прорывает 1×MIC за ≤36 ч; wt не берёт 10×MIC за 72 ч',
      pass: ok,
      details: runs.map(function (r, i) {
        return 'seed ' + seeds[i] + ': R в зоне 10× на ' + (r.crossT === null ? '—' : r.crossT.toFixed(0) + ' ч') +
          ', wt в зоне 100×: ' + r.wtHi.toFixed(0) + ' КОЕ';
      }).join('; '),
    };
  }

  // Т7. Экспорт CSV и hash-шаринг: buildCSV даёт заголовок+строки;
  //     serializeParams∘parseParams — обратимая сериализация сценария.
  function testExportHash() {
    const hist = [
      { t: 0, tot: [1e6, 0, 0, 1e4], S: 1000, A: 8 },
      { t: 0.5, tot: [2e6, 1.2e2, 0, 2.5e4], S: 940.5, A: 5.31 },
    ];
    const csv = E.buildCSV(hist);
    const lines = csv.split('\n');
    const csvOk = lines.length === 3 && lines[0].indexOf('t_h') === 0 &&
      lines[0].indexOf('N_ecor') > 0 && lines[1].indexOf('1.00000e+6') > 0;
    const params = { p: '2', seed: '777', dose: '18', kel: '1.0', pMut: '1e-6',
      S0: '1000', en: '1001', mu: '2.1,1.4,1,1.9', mic: '4,4,0.25,64', mode: 'infusion' };
    const rt = E.parseParams(E.serializeParams(params));
    const hashOk = JSON.stringify(rt) === JSON.stringify(params) &&
      E.parseParams(E.serializeParams({ a: 'x y&z' })).a === 'x y&z';
    return {
      name: 'Экспорт CSV (заголовок+строки) и hash-шаринг (round-trip сценария)',
      pass: csvOk && hashOk,
      details: 'CSV: ' + lines.length + ' строк, заголовок «' + lines[0] + '»; hash round-trip: ' + (hashOk ? 'ок' : 'FAIL'),
    };
  }

  // Т8. Хроника событий: детектор ловит начало гибели (АБ>MIC), спад АБ ниже MIC
  //     и последующий регроу; времена событий монотонны.
  function testChronicle() {
    const st = mk({ seed: 7, enabled: [true, false, false, false],
      env: { noise: 0, kel: 1.0, pMut: 0 } });
    E.lawn(st, 0, 1e6);
    E.bolusAB(st, 32); // старт выше MIC, далее элиминация t½ = 1 ч
    const fl = E.chronFlags();
    const chron = [];
    let k = 0;
    while (st.t < 12) {
      E.step(st, 0.05); k++;
      if (k % 2 === 0) E.chronicleStep(st, E.stats(st), fl)
        .forEach(function (e) { chron.push(e); });
    }
    const has = function (cls) { return chron.some(function (e) { return e.cls === cls; }); };
    let mono = true;
    for (let i = 1; i < chron.length; i++) if (chron[i].t < chron[i - 1].t - 1e-9) mono = false;
    const kill = chron.filter(function (e) { return e.cls === 'warn'; }).length;
    const regrow = chron.some(function (e) { return e.txt.indexOf('регроу') === 0; });
    const abUp = has('ab'), abDown = chron.some(function (e) { return e.txt.indexOf('АБ < MIC') === 0; });
    return {
      name: 'Хроника событий: гибель → АБ < MIC → регроу, времена монотонны',
      pass: abUp && kill >= 1 && abDown && regrow && mono,
      details: 'событий: ' + chron.length + ' [' + chron.map(function (e) {
        return 't=' + e.t.toFixed(1) + ' ' + e.txt.slice(0, 24);
      }).join(' | ') + ']',
    };
  }

  function runAll() {
    const tests = [testGrowth, testTimeKill, testSeed, testSelectionWindow, testInfusion, testMegaPlate, testExportHash, testChronicle];
    return tests.map(function (f) {
      try { return f(); }
      catch (e) { return { name: f.name, pass: false, details: 'ошибка: ' + e.message }; }
    });
  }

  return { runAll: runAll };
});

// CLI: node src/tests.js
if (typeof module !== 'undefined' && require.main === module) {
  const res = module.exports.runAll();
  let bad = 0;
  for (const r of res) {
    console.log((r.pass ? 'PASS' : 'FAIL') + '  ' + r.name);
    console.log('      ' + r.details);
    if (!r.pass) bad++;
  }
  console.log(bad === 0 ? '\nВсе ' + res.length + ' тестов зелёные' : '\nУпало: ' + bad);
  process.exit(bad === 0 ? 0 : 1);
}
