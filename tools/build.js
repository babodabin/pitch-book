#!/usr/bin/env node
// index.html 안에 엔진(tools/engine.js)과 확률표(data/out/pitch_table.json)를 끼워 넣는다.
// 파일은 index.html 하나로 유지 → 배포는 sw.js 의 CACHE 버전만 올리면 됨.
//
// 사용법:  node tools/build.js
// index.html 의 두 마커 사이가 통째로 바뀐다:
//   <!-- GAME:ENGINE:START --> … <!-- GAME:ENGINE:END -->
//   <!-- GAME:DATA:START -->   … <!-- GAME:DATA:END -->

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const RESULTS = ['ball', 'called', 'whiff', 'foul', 'out', 'single', 'double', 'hr'];

const engine = fs.readFileSync(path.join(ROOT, 'tools/engine.js'), 'utf8');
const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/out/pitch_table.json'), 'utf8'));

// 칸을 배열로 압축: [n, ball, called, whiff, foul, out, single, double, hr]
const pack = (c) => [c.n, ...RESULTS.map((r) => c[r])];
const data = {
  generated: json.generated,
  pitches: json.pitches,
  cells: Object.fromEntries(Object.entries(json.cells).map(([k, c]) => [k, pack(c)])),
  by_count: Object.fromEntries(Object.entries(json.by_count).map(([k, c]) => [k, pack(c)])),
};

let html = fs.readFileSync(HTML, 'utf8');
function replaceBlock(tag, body) {
  const a = `<!-- GAME:${tag}:START -->`, b = `<!-- GAME:${tag}:END -->`;
  const i = html.indexOf(a), j = html.indexOf(b);
  if (i < 0 || j < 0) throw new Error(`index.html 에 ${a} / ${b} 마커가 없습니다`);
  html = html.slice(0, i + a.length) + '\n' + body + '\n' + html.slice(j);
}
replaceBlock('ENGINE', '<script>\n' + engine.trim() + '\n</script>');
replaceBlock('DATA', '<script>window.PITCH_TABLE=' + JSON.stringify(data) + ';</script>');
fs.writeFileSync(HTML, html);

const kb = (n) => (n / 1024).toFixed(1) + 'KB';
console.log(`엔진 ${kb(engine.length)} + 확률표 ${kb(JSON.stringify(data).length)} → index.html ${kb(html.length)}`);
