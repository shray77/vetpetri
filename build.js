#!/usr/bin/env node
/*
 * Сборка single-file index.html из src/ (движок + тесты + UI + CSS инлайнятся в шаблон).
 * Корневой index.html — то, что раздаёт GitHub Pages: один файл, без внешних зависимостей.
 */
const fs = require('fs');
const path = require('path');
const root = __dirname; // build.js лежит в корне репы
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const tpl = read('src/index-template.html');
const css = read('src/style.css');
const engine = read('src/engine.js');
const tests = read('src/tests.js');
const ui = read('src/ui.js');

// tests.js в браузере требует VetPetriEngine глобально — ок (UMD). Убираем node-хвост CLI.
const testsBrowser = tests.replace(
  /\n\/\/ CLI: node src\/tests\.js[\s\S]*$/,
  '\n'
);

const out = tpl
  .replace('/*__CSS__*/', () => css)
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__TESTS__*/', () => testsBrowser)
  .replace('/*__UI__*/', () => ui);

if (out.includes('__CSS__') || out.includes('__ENGINE__') || out.includes('__TESTS__') || out.includes('__UI__')) {
  console.error('FAIL: остались маркеры в сборке');
  process.exit(1);
}
fs.writeFileSync(path.join(root, 'index.html'), out);
console.log('OK: index.html', (out.length / 1024).toFixed(1), 'KB');
