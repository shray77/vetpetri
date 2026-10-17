// Дебаг: трассировка окна селекции при 0.5 и 8 мг/л
const E = require('./src/engine.js');
function mk(cfg) {
  return E.createState(Object.assign({
    W: 20, H: 12, seed: 42, species: E.SPECIES,
    enabled: [true, false, false, true], wellMixed: true,
    env: { noise: 0, kel: 0, pMut: 0 },
  }, cfg));
}
const st = mk({});
E.lawn(st, 0, 1e7); E.lawn(st, 3, 1e5);
E.bolusAB(st, 0.5);
console.log('C50 wt/res:', E.c50Of(E.SPECIES[0], st.env).toFixed(2), E.c50Of(E.SPECIES[3], st.env).toFixed(2));
for (let k = 0; k < 60; k++) {
  for (let j = 0; j < 20; j++) E.step(st, 0.05);
  const s = E.stats(st);
  console.log('t=' + s.t.toFixed(1), 'wt=' + s.totals[0].toExponential(2), 'R=' + s.totals[3].toExponential(2),
    'S=' + s.S.toFixed(1), 'q=' + st.q[0].toFixed(3));
}
