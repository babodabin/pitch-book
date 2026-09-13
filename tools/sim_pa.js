#!/usr/bin/env node
// 2단계 — 화면 없이 타석 굴리기 (숫자로만 검증)
//
// 사용법:
//   node tools/sim_pa.js                       기본 검증 세트 전부
//   node tools/sim_pa.js one [RR] [seed]       타석 하나를 투구별로 출력
//   node tools/sim_pa.js fixed FF 5 [RR]       한 (구종, 칸)만 계속 던지면 어떻게 되나
//   node tools/sim_pa.js cell FF 5 RR          칸 하나의 확률·표본·물러난 단계 보기

'use strict';
const fs = require('fs');
const path = require('path');
const E = require('./engine');

const ROOT = path.resolve(__dirname, '..');
const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/out/pitch_table.json'), 'utf8'));
const table = E.buildTable(json);
const REF = json.pa_reference;
const OUTCOMES = ['walk', 'strikeout', 'out', 'single', 'double', 'hr'];
const KO = { walk: '볼넷', strikeout: '삼진', out: '아웃', single: '단타', double: '2루타', hr: '홈런',
  ball: '볼', called: '루킹', take: '안 휘두름', whiff: '헛스윙', foul: '파울' };

function pct(a, b) { return (a / b * 100).toFixed(1).padStart(5) + '%'; }

// n 타석 돌려서 결과 분포 반환
function runMany(n, hands, policyFactory, opts) {
  const cnt = {}; for (const o of OUTCOMES) cnt[o] = 0;
  let pitches = 0;
  for (let i = 0; i < n; i++) {
    const r = E.simulatePA(table, hands, policyFactory(hands), opts);
    cnt[r.outcome]++; pitches += r.pitches.length;
  }
  return { n, cnt, ppa: pitches / n };
}

function printRow(label, r, ref) {
  const cols = OUTCOMES.map((o) => pct(r.cnt[o], r.n));
  console.log(`  ${label.padEnd(22)} ${cols.join(' ')}   ${r.ppa.toFixed(2)}구`);
  if (ref) {
    const rc = OUTCOMES.map((o) => pct(ref[o], ref.pa));
    console.log(`  ${'실제 (같은 CSV)'.padEnd(22)} ${rc.join(' ')}   ${(ref.pitches / ref.pa).toFixed(2)}구`);
  }
}

function header() {
  console.log(`  ${''.padEnd(22)} ${OUTCOMES.map((o) => KO[o].padStart(6)).join(' ')}   타석당`);
}

// ---------- 모드 ----------
const [mode, ...args] = process.argv.slice(2);

if (mode === 'one') {
  const hands = args[0] || 'RR';
  const seed = Number(args[1]) || Math.floor(Math.random() * 1e9);
  const rng = E.mulberry32(seed);
  const r = E.simulatePA(table, hands, E.randomPolicy(rng), { rng });
  console.log(`타석 하나 (${hands}, seed ${seed}) — 구종·칸 무작위, 실투 켜짐`);
  for (const p of r.pitches) {
    const moved = p.aim !== p.zone ? `→ 실제 ${p.zone}` : '        ';
    console.log(`  ${p.count.padEnd(4)} ${p.pitchType} 노림 ${String(p.aim).padStart(2)} ${moved}  ${KO[p.result]}`);
  }
  console.log(`  결과: ${KO[r.outcome]} (${r.pitches.length}구)`);

} else if (mode === 'cell') {
  const [pt, z, h] = args;
  const key = `${pt}|${z}|${h}`;
  const p = table.probs[key], c = table.cells[key];
  console.log(`${key}  표본 ${c.n}구  (${table.level[key]} 수준 값)`);
  for (const r of E.PROB_KEYS) {
    const raw = r === 'take' ? c.ball + c.called : c[r];
    console.log(`  ${KO[r].padEnd(5)} 원본 ${pct(raw, c.n || 1)}  →  사용 ${pct(p[r], 1)}`);
  }

} else if (mode === 'fixed') {
  const [pt, z, h = 'RR'] = args;
  const N = 20000;
  console.log(`${pt} ${z}번 칸만 ${N}타석 (${h})`);
  header();
  printRow('실투·보정 없음', runMany(N, h, () => E.fixedPolicy(pt, Number(z)), { wobble: false, countAdjust: false }));
  printRow('보정만', runMany(N, h, () => E.fixedPolicy(pt, Number(z)), { wobble: false }));
  printRow('실투·보정 있음', runMany(N, h, () => E.fixedPolicy(pt, Number(z)), { wobble: true }), REF);

} else {
  const N = 50000;
  const rng = E.mulberry32(20260913);

  console.log('== 1. 표 되돌리기: 실제 사용 빈도대로 던지고 실투·타자 AI·난이도 끔  →  실제 타석 결과와 맞아야 함');
  const hit0 = E.AI.hit; E.AI.hit = 1;   // 표 자체를 검증하는 구간이라 난이도·노림은 끔
  header();
  printRow('보정 없음·위치도 무관', runMany(N, 'RR', (hh) => E.makeUsagePolicy(table, hh, rng, null), { wobble: false, countAdjust: false, ai: false, rng }));
  printRow('보정 있음·위치 무관', runMany(N, 'RR', (hh) => E.makeUsagePolicy(table, hh, rng, null), { wobble: false, ai: false, rng }));
  for (const h of E.HANDS)
    printRow(h + ' (보정·위치 다 반영)', runMany(N, h, (hh) => E.makeUsagePolicy(table, hh, rng), { wobble: false, ai: false, rng }));
  // 좌우 4조합을 실제 비율로 섞은 값
  const mix = { n: 0, cnt: {}, ppa: 0 }; for (const o of OUTCOMES) mix.cnt[o] = 0;
  const totN = E.HANDS.reduce((s, h) => s + E.ZONES.reduce((t, z) => t + E.PITCH_TYPES.reduce((u, p) => u + table.ns[`${p}|${z}|${h}`], 0), 0), 0);
  let ppaAcc = 0;
  for (const h of E.HANDS) {
    const share = E.ZONES.reduce((t, z) => t + E.PITCH_TYPES.reduce((u, p) => u + table.ns[`${p}|${z}|${h}`], 0), 0) / totN;
    const r = runMany(Math.round(N * share), h, (hh) => E.makeUsagePolicy(table, hh, rng), { wobble: false, ai: false, rng });
    mix.n += r.n; for (const o of OUTCOMES) mix.cnt[o] += r.cnt[o]; ppaAcc += r.ppa * r.n;
  }
  mix.ppa = ppaAcc / mix.n;
  printRow('4조합 합침', mix, REF);
  E.AI.hit = hit0;

  console.log('\n== 2. 같은 정책에 실투만 켬  →  얼마나 달라지나');
  header();
  printRow('실투 켬 (RR)', runMany(N, 'RR', (hh) => E.makeUsagePolicy(table, hh, rng), { wobble: true, rng }));

  console.log('\n== 3. 극단 정책 (RR, 실투 켬)  →  게임에서 뻔한 수가 통하면 안 됨');
  header();
  const tests = [
    ['FF 5 (한가운데 직구)', E.fixedPolicy('FF', 5)],
    ['FF 2 (높은 직구)', E.fixedPolicy('FF', 2)],
    ['SL 14 (바깥 낮은 슬라)', E.fixedPolicy('SL', 14)],
    ['SL 9 (존 안 낮은 슬라)', E.fixedPolicy('SL', 9)],
    ['CU 13 (낮은 커브)', E.fixedPolicy('CU', 13)],
    ['CH 14 (낮은 체인지업)', E.fixedPolicy('CH', 14)],
    ['FS 8 (낮은 스플리터)', E.fixedPolicy('FS', 8)],
    ['구종·칸 완전 무작위', E.randomPolicy(rng)],
  ];
  for (const [label, pol] of tests) printRow(label, runMany(N, 'RR', () => pol, { wobble: true, rng }));

  console.log('\n== 4. 실투로 노린 칸에서 벗어나는 비율 (구종별)');
  for (const pt of E.PITCH_TYPES) {
    let stay = 0, out = 0, T = 20000;
    for (let i = 0; i < T; i++) { const a = E.applyWobble(pt, 5, rng); if (a.zone === 5) stay++; }
    for (let i = 0; i < T; i++) { const a = E.applyWobble(pt, 14, rng); if (a.zone <= 9) out++; }
    console.log(`  ${pt}  5번 노려서 5번 ${pct(stay, T)}   14번 노려서 존 안으로 ${pct(out, T)}`);
  }
}
