#!/usr/bin/env node
// 3·6단계 — 화면 없이 이닝 굴리기 (승률 확인, 타자 AI 밸런스)
//
// 사용법:
//   node tools/sim_inning.js              정책별 승률 (각 2만 판)
//   node tools/sim_inning.js one [seed]   한 판을 타석·투구별로 출력 (타자 노림 포함)

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
  console.log(`한 판 (seed ${seed}) — 우투, 구종·칸 무작위, 실투·카운트 보정·타자 노림 켜짐`);
  console.log(`  시작: ${E.START.outs}사 ${basesStr(E.START.bases)}`);
  for (const pa of r.pas) {
    console.log(`  [${pa.hands[1]}타]`);
    for (const p of pa.pitches) {
      const moved = p.aim !== p.zone ? `→ ${String(p.zone).padStart(2)}` : '    ';
      const ex = p.expect ? `노림 ${E.GROUP_KO[p.expect.group]} ${String(p.expect.zone).padStart(2)} (일치 ${p.match.toFixed(2)})` : '';
      console.log(`     ${p.count.padEnd(4)} ${p.pitchType} ${String(p.aim).padStart(2)} ${moved}  ${KO[p.result].padEnd(4)} ${ex}`);
    }
    console.log(`     → ${KO[pa.outcome]}${pa.runs ? `  실점 ${pa.runs}` : ''}   ${pa.outs}사 ${basesStr(pa.bases)}`);
  }
  console.log(`  ${r.won ? '승리' : `패배 (${r.runs}실점)`}`);
} else {
  const N = 20000;
  const rng = E.mulberry32(20260913);
  const batter = () => (rng() < LEFT_SHARE ? 'L' : 'R');

  function run(label, policyFactory, opts, brief) {
    let won = 0, lost = 0, draw = 0, extra = 0, pas = 0, pitches = 0;
    const paCnt = {};
    for (let i = 0; i < N; i++) {
      const r = E.simulateGame(table, 'R', batter, policyFactory(), { rng, lineup: E.LINEUP, ...opts });
      if (r.result === 'win') won++; else if (r.result === 'lose') lost++; else draw++;
      if (r.innings > 9) extra++;
      pas += r.pas.length;
      for (const pa of r.pas) { pitches += pa.pitches.length; paCnt[pa.outcome] = (paCnt[pa.outcome] || 0) + 1; }
    }
    console.log(`  ${label.padEnd(26)} 승 ${pct(won, N)} 패 ${pct(lost, N)} 무 ${pct(draw, N)}  연장 ${pct(extra, N)}  판당 ${(pas / N).toFixed(1)}타석 ${(pitches / N).toFixed(0)}구   볼넷 ${pct(paCnt.walk || 0, pas)} 삼진 ${pct(paCnt.strikeout || 0, pas)} 홈런 ${pct(paCnt.hr || 0, pas)}`);
  }

  const seqPolicy = (seq) => () => { let i = 0; return () => { const s = seq[i++ % seq.length]; return { pitchType: s[0], zone: s[1] }; }; };

  console.log(`== 정책별 승률 (각 ${N}판, 우투, 시작 ${E.START.outs}사 ${basesStr(E.START.bases)})`);
  console.log('   9회말 3:2 1사 1·2루 → 동점이면 연장(승부치기 무사 2루, 12회까지). 9회 무실점 확률 실측 ≈ 59%');
  console.log(`   타자 AI 노림 켜짐 (memory=${E.AI.memory}). 뻔한 정책은 평균보다 훨씬 낮아야 함\n`);
  const policies = [
    ['평균 투수 (실제 빈도, 실투 끔)', () => E.makeUsagePolicy(table, 'RR', rng), { wobble: false }],
    ['평균 투수 + 실투(기본)', () => E.makeUsagePolicy(table, 'RR', rng), {}],
    ['구종·칸 완전 무작위', () => E.randomPolicy(rng), {}],
    ['FF 5번만', () => E.fixedPolicy('FF', 5), {}],
    ['FF 2번만 (높은 직구)', () => E.fixedPolicy('FF', 2), {}],
    ['SL 9번만', () => E.fixedPolicy('SL', 9), {}],
    ['SL 14번만 (유인구)', () => E.fixedPolicy('SL', 14), {}],
    ['CU 8번만', () => E.fixedPolicy('CU', 8), {}],
    ['FF 2 ↔ SL 14 번갈아', seqPolicy([['FF', 2], ['SL', 14]]), {}],
    ['FF2·CH8·SL9·FF5·CU8 순환', seqPolicy([['FF', 2], ['CH', 8], ['SL', 9], ['FF', 5], ['CU', 8]]), {}],
  ];
  for (const [label, pf, o] of policies) run(label, pf, o);

  console.log('\n== 타자 AI 끔 (비교용)');
  run('평균 투수 (AI 없음)', () => E.makeUsagePolicy(table, 'RR', rng), { wobble: false, ai: false }, true);
  run('FF 2번만 (AI 없음)', () => E.fixedPolicy('FF', 2), { ai: false }, true);
  run('무작위 (AI 없음)', () => E.randomPolicy(rng), { ai: false }, true);

  console.log('\n== 기억 감도(AI.memory)에 따른 승률');
  const mem0 = E.AI.memory;
  for (const m of [0, 0.5, 1, 2, 4]) {
    E.AI.memory = m;
    console.log(`  memory=${m}`);
    run('  평균 투수', () => E.makeUsagePolicy(table, 'RR', rng), { wobble: false }, true);
    run('  FF 2번만', () => E.fixedPolicy('FF', 2), {}, true);
    run('  무작위', () => E.randomPolicy(rng), {}, true);
    run('  5구 순환', seqPolicy([['FF', 2], ['CH', 8], ['SL', 9], ['FF', 5], ['CU', 8]]), {}, true);
  }
  E.AI.memory = mem0;
}
