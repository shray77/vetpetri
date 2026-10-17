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

  function runAll() {
    const tests = [testGrowth, testTimeKill, testSeed, testSelectionWindow];
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
