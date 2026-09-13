#!/usr/bin/env node
// 3단계 — 화면 없이 이닝 굴리기 (승률 확인)
//
// 사용법:
//   node tools/sim_inning.js              정책별 승률 (각 2만 판)
//   node tools/sim_inning.js one [seed]   한 판을 타석·투구별로 출력

'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./engine');

const ROOT = path.resolve(__dirname, '..');
const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/out/pitch_table.json'), 'utf8'));
const table = E.buildTable(json);
const KO = { walk: '볼넷', strikeout: '삼진', out: '아웃', single: '단타', double: '2루타', hr: '홈런',
  ball: '볼', called: '루킹', whiff: '헛스윙', foul: '파울' };
const LEFT_SHARE = 0.47; // 타자 중 좌타 비율 (CSV 실측)

function pct(a, b) { return (a / b * 100).toFixed(1).padStart(5) + '%'; }
function basesStr(b) { return (b[0] ? '1' : '·') + (b[1] ? '2' : '·') + (b[2] ? '3' : '·'); }

const [mode, ...args] = process.argv.slice(2);

if (mode === 'one') {
  const seed = Number(args[0]) || Math.floor(Math.random() * 1e9);
  const rng = E.mulberry32(seed);
  const batter = () => (rng() < LEFT_SHARE ? 'L' : 'R');
  const r = E.simulateInning(table, 'R', batter, E.randomPolicy(rng), { rng });
  console.log(`한 판 (seed ${seed}) — 우투, 구종·칸 무작위, 실투·카운트 보정 켜짐`);
  console.log(`  시작: ${E.START.outs}사 ${basesStr(E.START.bases)}`);
  for (const pa of r.pas) {
    console.log(`  [${pa.hands[1]}타]`);
    for (const p of pa.pitches) {
      const moved = p.aim !== p.zone ? `→ ${String(p.zone).padStart(2)}` : '    ';
      console.log(`     ${p.count.padEnd(4)} ${p.pitchType} ${String(p.aim).padStart(2)} ${moved}  ${KO[p.result]}`);
    }
    console.log(`     → ${KO[pa.outcome]}${pa.runs ? `  실점 ${pa.runs}` : ''}   ${pa.outs}사 ${basesStr(pa.bases)}`);
  }
  console.log(`  ${r.won ? '승리' : `패배 (${r.runs}실점)`}`);
} else {
  const N = 20000;
  const rng = E.mulberry32(20260913);
  const batter = () => (rng() < LEFT_SHARE ? 'L' : 'R');

  function run(label, policyFactory, opts) {
    let won = 0, runs = 0, pas = 0, pitches = 0;
    const paCnt = {}, firstRun = {};
    for (let i = 0; i < N; i++) {
      const r = E.simulateInning(table, 'R', batter, policyFactory(), { rng, ...opts });
      if (r.won) won++;
      runs += r.runs; pas += r.pas.length;
      for (const pa of r.pas) { pitches += pa.pitches.length; paCnt[pa.outcome] = (paCnt[pa.outcome] || 0) + 1; }
      if (!r.won) { const k = r.pas[r.pas.length - 1].outcome; firstRun[k] = (firstRun[k] || 0) + 1; }
    }
    const lost = N - won;
    const ends = Object.entries(firstRun).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${KO[k]} ${pct(v, lost)}`).join(' ');
    console.log(`  ${label.padEnd(24)} 승률 ${pct(won, N)}   판당 ${(pas / N).toFixed(2)}타석 ${(pitches / N).toFixed(1)}구   볼넷 ${pct(paCnt.walk || 0, pas)} 삼진 ${pct(paCnt.strikeout || 0, pas)}`);
    console.log(`  ${''.padEnd(24)} 졌을 때 실점 계기: ${ends}`);
  }

  console.log(`== 정책별 승률 (각 ${N}판, 우투, 시작 ${E.START.outs}사 ${basesStr(E.START.bases)})`);
  console.log('   기준: 실제 야구에서 1사 1·2루 무실점 확률 ≈ 59%\n');
  run('평균 투수 (실제 빈도, 실투 끔)', () => E.makeUsagePolicy(table, 'RR', rng), { wobble: false });
  run('평균 투수 + 실투(기본)', () => E.makeUsagePolicy(table, 'RR', rng), {});
  run('구종·칸 완전 무작위', () => E.randomPolicy(rng), {});
  run('FF 5번만', () => E.fixedPolicy('FF', 5), {});
  run('FF 2번만 (높은 직구)', () => E.fixedPolicy('FF', 2), {});
  run('SL 9번만', () => E.fixedPolicy('SL', 9), {});
  run('SL 14번만 (유인구)', () => E.fixedPolicy('SL', 14), {});
  run('CU 8번만', () => E.fixedPolicy('CU', 8), {});

  console.log('\n== 실투 폭 배율에 따른 승률 (평균 투수 정책)');
  for (const scale of [0, 0.5, 1, 1.5]) {
    const W = { ...E.WOBBLE };
    for (const k in E.WOBBLE) E.WOBBLE[k] = W[k] * scale;
    run(`실투 ×${scale}`, () => E.makeUsagePolicy(table, 'RR', rng), { wobble: scale > 0 });
    Object.assign(E.WOBBLE, W);
  }
}
