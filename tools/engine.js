// 한 이닝 게임 엔진 — 순수 함수만. 파일·화면 없음.
// Node(시뮬)와 브라우저(index.html에 인라인) 양쪽에서 같은 파일을 쓴다.
//
// 흐름:  고른 (구종, 칸)  →  실투 흔들림  →  실제 도달점  →  칸 확률표에서 결과 뽑기  →  카운트 갱신
//
// 확률표: 얇은 칸은 상위 칸으로 물러난다 (경험적 베이즈 수축)
//   칸 (구종×zone×좌우)  ←  구종×zone (좌우 합침)  ←  구종 전체
//   p = (칸 건수 + K × 상위 확률) / (칸 구수 + K)     K = PRIOR_WEIGHT
// 카운트 보정: 같은 CSV의 카운트별×존안팎 결과 분포로 배수를 곱한다 (타자의 카운트 반응)
//
// 단위: 미터. 포수 시점에서 x<0 이 왼쪽(3루쪽), z 는 높이.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PitchEngine = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const PITCH_TYPES = ['FF', 'SI', 'FC', 'SL', 'ST', 'CU', 'KC', 'CH', 'FS', 'SV'];
const ZONES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14];
const HANDS = ['RR', 'RL', 'LR', 'LL'];
const RESULTS = ['ball', 'called', 'whiff', 'foul', 'out', 'single', 'double', 'hr'];
// 확률표 안에서는 볼·루킹을 "안 휘두름(take)" 하나로 합친다. 볼/루킹은 도달점을 ABS 가 가른다.
const PROB_KEYS = ['take', 'whiff', 'foul', 'out', 'single', 'double', 'hr'];
const IN_PLAY = new Set(['out', 'single', 'double', 'hr']);

const PRIOR_WEIGHT = 50; // 상위 칸을 몇 구짜리 표본으로 칠지 (설계값)

// ---------- 존 좌표 (미터) — 도감 index.html 의 ZONE_W / ZONE_BOT / ZONE_TOP 과 같음 ----------
const ZONE_GEOM = {
  halfW: 0.215,          // 홈플레이트 43cm / 2
  bot: 0.50, top: 1.05,
  offOut: 0.14,          // 존 밖 칸을 노릴 때 존 가장자리에서 얼마나 바깥을 겨누는지
};

// 칸 번호 → 노리는 점
function zoneTarget(zone) {
  const g = ZONE_GEOM;
  const cw = (2 * g.halfW) / 3, ch = (g.top - g.bot) / 3;
  if (zone <= 9) {
    const col = (zone - 1) % 3, row = Math.floor((zone - 1) / 3); // row 0 = 위
    return { x: -g.halfW + cw * (col + 0.5), z: g.top - ch * (row + 0.5) };
  }
  const left = zone === 11 || zone === 13, up = zone === 11 || zone === 12;
  return { x: (left ? -1 : 1) * (g.halfW + g.offOut), z: up ? g.top + g.offOut : g.bot - g.offOut };
}

// 점 → 칸 번호
function pointToZone(x, z) {
  const g = ZONE_GEOM;
  if (Math.abs(x) <= g.halfW && z >= g.bot && z <= g.top) {
    const col = Math.min(2, Math.floor((x + g.halfW) / (2 * g.halfW / 3)));
    const row = Math.min(2, Math.floor((g.top - z) / ((g.top - g.bot) / 3)));
    return row * 3 + col + 1;
  }
  const mid = (g.top + g.bot) / 2;
  if (z >= mid) return x < 0 ? 11 : 12;
  return x < 0 ? 13 : 14;
}

// ---------- 실투 흔들림 (구종별 표준편차, 미터) — 설계값 ----------
const WOBBLE = {
  FF: 0.09, SI: 0.10, FC: 0.10, SL: 0.12, ST: 0.14,
  CU: 0.17, KC: 0.17, CH: 0.13, FS: 0.17, SV: 0.15,
};
const WOBBLE_SCALE = 0.5; // 3단계 결과로 절반에서 시작. 6단계에서 조정

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 노린 칸 → 실제 도달점
function applyWobble(pitchType, zone, rng, scale) {
  if (scale === undefined) scale = WOBBLE_SCALE;
  const t = zoneTarget(zone);
  const s = WOBBLE[pitchType] * scale;
  const x = t.x + gauss(rng) * s, z = t.z + gauss(rng) * s;
  return { zone: pointToZone(x, z), x, z };
}

// ---------- 확률표 ----------
function emptyCounts() { const c = { n: 0 }; for (const r of PROB_KEYS) c[r] = 0; return c; }

// 원본 칸 {n, ball, called, ...} → take 로 합친 건수
function takeCounts(c) {
  const o = { n: c.n, take: c.ball + c.called };
  for (const r of PROB_KEYS) if (r !== 'take') o[r] = c[r];
  return o;
}

function normalize(counts, n) {
  const p = {};
  for (const r of PROB_KEYS) p[r] = n ? counts[r] / n : 0;
  return p;
}

function shrink(counts, n, prior, k) {
  const p = {};
  for (const r of PROB_KEYS) p[r] = (counts[r] + k * prior[r]) / (n + k);
  return p;
}

function sumCells(list) {
  const s = emptyCounts();
  for (const c of list) { s.n += c.n; for (const r of PROB_KEYS) s[r] += c[r]; }
  return s;
}

// 카운트 보정 배수: adj["b-s|in"][result] = p(result | 카운트, 존안팎) / p(result | 존안팎)
function buildCountAdjust(byCount) {
  const base = { in: emptyCounts(), out: emptyCounts() };
  const tc = {};
  for (const [k, c] of Object.entries(byCount)) {
    const io = k.split('|')[1];
    tc[k] = takeCounts(c);
    base[io].n += c.n; for (const r of PROB_KEYS) base[io][r] += tc[k][r];
  }
  const adj = {};
  for (const [k, c] of Object.entries(tc)) {
    const io = k.split('|')[1];
    adj[k] = {};
    for (const r of PROB_KEYS) {
      const pc = (c[r] + 1) / (c.n + PROB_KEYS.length);          // 라플라스 (0 나누기 방지)
      const pb = (base[io][r] + 1) / (base[io].n + PROB_KEYS.length);
      adj[k][r] = pc / pb;
    }
  }
  return adj;
}

function adjustByCount(p, adj, balls, strikes, zone) {
  const a = adj[`${balls}-${strikes}|${zone <= 9 ? 'in' : 'out'}`];
  if (!a) return p;
  const q = {}; let s = 0;
  for (const r of PROB_KEYS) { q[r] = p[r] * a[r]; s += q[r]; }
  for (const r of PROB_KEYS) q[r] /= s;
  return q;
}

// 칸 데이터는 객체 {n, ball, ...} 또는 압축 배열 [n, ball, called, ...] 둘 다 받는다
function cellObj(c) {
  if (!Array.isArray(c)) return c;
  const o = { n: c[0] };
  RESULTS.forEach((r, i) => { o[r] = c[i + 1]; });
  return o;
}

// pitch_table.json → { probs[key], ns[key], level[key], countAdj, byCount, ... }
function buildTable(json, priorWeight = PRIOR_WEIGHT) {
  const cells = {}, tcells = {};
  for (const k in json.cells) { cells[k] = cellObj(json.cells[k]); tcells[k] = takeCounts(cells[k]); }
  const byCount = json.by_count ? Object.fromEntries(Object.entries(json.by_count).map(([k, c]) => [k, cellObj(c)])) : null;
  const probs = {}, ns = {}, level = {};
  const all = sumCells(Object.values(tcells));
  const pAll = normalize(all, all.n);
  const countAdj = byCount ? buildCountAdjust(byCount) : null;

  for (const pt of PITCH_TYPES) {
    const ptCells = [];
    for (const z of ZONES) for (const h of HANDS) ptCells.push(tcells[`${pt}|${z}|${h}`]);
    const ptSum = sumCells(ptCells);
    const pPt = shrink(ptSum, ptSum.n, pAll, priorWeight);

    for (const z of ZONES) {
      const zSum = sumCells(HANDS.map((h) => tcells[`${pt}|${z}|${h}`]));
      const pZone = shrink(zSum, zSum.n, pPt, priorWeight);

      for (const h of HANDS) {
        const key = `${pt}|${z}|${h}`;
        const c = tcells[key];
        probs[key] = shrink(c, c.n, pZone, priorWeight);
        ns[key] = c.n;
        level[key] = c.n >= 200 ? '칸' : zSum.n >= 200 ? '구종×존' : '구종';
      }
    }
  }
  return { probs, ns, level, cells, countAdj, byCount, pitchTypes: PITCH_TYPES, zones: ZONES, hands: HANDS };
}

function sampleResult(p, rng) {
  let r = rng();
  for (const k of PROB_KEYS) { r -= p[k]; if (r < 0) return k; }
  return PROB_KEYS[PROB_KEYS.length - 1];
}

// ---------- 타석 (투구 하나씩) ----------
function startPA(hands) {
  return { balls: 0, strikes: 0, hands, history: [], outcome: null };
}

// 투구 하나. pick = { pitchType, zone }
// 옵션: wobble (기본 true), wobbleScale, countAdjust (기본 true), rng,
//       judge(x, z) → true=스트라이크 : 안 휘두른 공의 볼/루킹을 가르는 판정 (도감 ABS를 넘겨줌)
// 반환 rec: { pitchType, aim, zone, x, z, result, count, outcome }  outcome 은 타석이 끝났을 때만
function throwPitch(table, st, pick, opts = {}) {
  const rng = opts.rng || Math.random;
  const wobble = opts.wobble !== false;
  const countAdjust = opts.countAdjust !== false && table.countAdj;

  const aimPt = zoneTarget(pick.zone);
  const land = wobble ? applyWobble(pick.pitchType, pick.zone, rng, opts.wobbleScale)
                      : { zone: pick.zone, x: aimPt.x, z: aimPt.z };
  const key = `${pick.pitchType}|${land.zone}|${st.hands}`;
  let p = table.probs[key];
  if (countAdjust) p = adjustByCount(p, table.countAdj, st.balls, st.strikes, land.zone);
  let result = sampleResult(p, rng);
  if (result === 'take') {
    const strike = opts.judge ? opts.judge(land.x, land.z) : land.zone <= 9;
    result = strike ? 'called' : 'ball';
  }

  const rec = { pitchType: pick.pitchType, aim: pick.zone, zone: land.zone, x: land.x, z: land.z,
                result, count: `${st.balls}-${st.strikes}`, outcome: null };

  if (IN_PLAY.has(result)) rec.outcome = result;
  else if (result === 'ball') { st.balls++; if (st.balls === 4) rec.outcome = 'walk'; }
  else if (result === 'foul') { if (st.strikes < 2) st.strikes++; }
  else { st.strikes++; if (st.strikes === 3) rec.outcome = 'strikeout'; }

  st.history.push(rec);
  if (rec.outcome) st.outcome = rec.outcome;
  return rec;
}

// 타석 하나를 끝까지. choose(state) → { pitchType, zone }
function simulatePA(table, hands, choose, opts = {}) {
  const st = startPA(hands);
  for (let i = 0; i < 30; i++) {
    const rec = throwPitch(table, st, choose(st), opts);
    if (rec.outcome) return { outcome: rec.outcome, pitches: st.history };
  }
  return { outcome: 'out', pitches: st.history }; // 30구 넘어가면 강제 종료 (실제론 안 옴)
}

// ---------- 이닝 ----------
// 주자 진루 규칙 (설계값)
const RUNNER_RULES = {
  singleScoreFrom2: 0.60,  // 단타 때 2루 주자가 홈까지 올 확률 (아니면 3루)
  doubleScoreFrom1: 0.45,  // 2루타 때 1루 주자가 홈까지 올 확률 (아니면 3루)
  sacFly: 0.25,            // 2사 전 아웃 때 3루 주자가 득점할 확률
};

// 시작 상황: 9회말 3:2 리드, 1사 1·2루 → 무실점으로 3아웃이면 승리
const START = { outs: 1, bases: [true, true, false] }; // [1루, 2루, 3루]

function startInning() {
  return { outs: START.outs, bases: START.bases.slice(), runs: 0 };
}

// 타석 결과 하나를 주자·아웃에 적용. 반환: 이번 타석 실점 (st.runs 에도 누적)
function applyOutcome(st, outcome, rng = Math.random) {
  const b = st.bases;
  let runs = 0;
  switch (outcome) {
    case 'strikeout':
      st.outs++; break;
    case 'out':
      if (st.outs < 2 && b[2] && rng() < RUNNER_RULES.sacFly) { runs++; b[2] = false; }
      st.outs++; break;
    case 'walk':
      if (b[0] && b[1] && b[2]) runs++;
      else if (b[0] && b[1]) b[2] = true;
      else if (b[0]) b[1] = true;
      b[0] = true; break;
    case 'single': {
      if (b[2]) runs++;
      let to3 = false;
      if (b[1]) { if (rng() < RUNNER_RULES.singleScoreFrom2) runs++; else to3 = true; }
      st.bases = [true, b[0], to3]; break;
    }
    case 'double': {
      if (b[2]) runs++;
      if (b[1]) runs++;
      let to3 = false;
      if (b[0]) { if (rng() < RUNNER_RULES.doubleScoreFrom1) runs++; else to3 = true; }
      st.bases = [false, true, to3]; break;
    }
    case 'hr':
      runs += 1 + b.filter(Boolean).length;
      st.bases = [false, false, false]; break;
  }
  st.runs += runs;
  return runs;
}

function inningOver(st) { return st.outs >= 3 || st.runs > 0; }

// 이닝 하나. batterHands(i) → 'R' | 'L' (i번째 타자), choose(state) → {pitchType, zone}
function simulateInning(table, pitcherHand, batterHands, choose, opts = {}) {
  const rng = opts.rng || Math.random;
  const st = startInning();
  const pas = [];
  for (let i = 0; !inningOver(st); i++) {
    const hands = pitcherHand + batterHands(i);
    const pa = simulatePA(table, hands, choose, opts);
    const r = applyOutcome(st, pa.outcome, rng);
    pas.push({ hands, outcome: pa.outcome, pitches: pa.pitches, runs: r, outs: st.outs, bases: st.bases.slice() });
  }
  return { won: st.runs === 0, runs: st.runs, pas, outs: st.outs };
}

// ---------- 투수 정책 몇 가지 (검증용) ----------
// 실제 사용 빈도대로 (구종, 칸) 을 뽑음 — 표를 그대로 되돌려 보는 용도
// 카운트별 존 안/밖 비율을 따른다 (3볼이면 존 안, 0-2 면 존 밖이 늘어남) — 투수 쪽 카운트 반응
function makeUsagePolicy(table, hands, rng = Math.random, byCount = table.byCount) {
  const groups = { in: { keys: [], w: [], tot: 0 }, out: { keys: [], w: [], tot: 0 } };
  for (const pt of PITCH_TYPES) for (const z of ZONES) {
    const g = groups[z <= 9 ? 'in' : 'out'];
    const n = table.ns[`${pt}|${z}|${hands}`];
    g.keys.push({ pitchType: pt, zone: z }); g.w.push(n); g.tot += n;
  }
  const pick = (g) => {
    let r = rng() * g.tot;
    for (let i = 0; i < g.keys.length; i++) { r -= g.w[i]; if (r < 0) return g.keys[i]; }
    return g.keys[g.keys.length - 1];
  };
  return (state) => {
    let pIn = groups.in.tot / (groups.in.tot + groups.out.tot);
    if (byCount && state) {
      const a = byCount[`${state.balls}-${state.strikes}|in`], b = byCount[`${state.balls}-${state.strikes}|out`];
      if (a && b && a.n + b.n > 0) pIn = a.n / (a.n + b.n);
    }
    return pick(rng() < pIn ? groups.in : groups.out);
  };
}

function fixedPolicy(pitchType, zone) {
  return () => ({ pitchType, zone });
}

function randomPolicy(rng = Math.random) {
  return () => ({
    pitchType: PITCH_TYPES[Math.floor(rng() * PITCH_TYPES.length)],
    zone: ZONES[Math.floor(rng() * ZONES.length)],
  });
}

// 시드 난수 (재현용)
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

return {
  PITCH_TYPES, ZONES, HANDS, RESULTS, PROB_KEYS, IN_PLAY, PRIOR_WEIGHT, WOBBLE, WOBBLE_SCALE, ZONE_GEOM,
  zoneTarget, pointToZone, applyWobble,
  buildTable, buildCountAdjust, adjustByCount, sampleResult,
  startPA, throwPitch, simulatePA,
  RUNNER_RULES, START, startInning, applyOutcome, inningOver, simulateInning,
  makeUsagePolicy, fixedPolicy, randomPolicy, mulberry32,
};
}));
