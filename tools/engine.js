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
  // 앞 공 → 이 공 (좌우별은 전체 쌍으로 수축)
  const byPrev = {};
  if (json.by_prev) {
    for (const a of PITCH_TYPES) for (const b of PITCH_TYPES) {
      const all = takeCounts(cellObj(json.by_prev[`${a}|${b}|ALL`]));
      const pAll2 = normalize(all, all.n);
      byPrev[`${a}|${b}|ALL`] = { n: all.n, p: pAll2 };
      for (const h of HANDS) {
        const c = takeCounts(cellObj(json.by_prev[`${a}|${b}|${h}`]));
        byPrev[`${a}|${b}|${h}`] = { n: c.n, nAll: all.n, p: shrink(c, c.n, pAll2, 100) };
      }
    }
  }
  return { probs, ns, level, cells, countAdj, byCount, byPrev, pitchTypes: PITCH_TYPES, zones: ZONES, hands: HANDS };
}

// ---------- 도감용: 이 공은 어디가 좋고, 이 조합은 어떤가, 앞에 뭘 던지면 좋나 ----------
// 투수 점수: 헛스윙·아웃은 +, 안타·장타는 −. 안 휘두른 공은 존 안이면 스트라이크(+), 밖이면 볼(−)
// 두 가지 눈: 'count' = 카운트 잡기 (루킹도 값짐, 볼은 손해)  /  'finish' = 결정구, 2스트라이크 (헛스윙이 전부, 볼은 덜 손해)
const SCORE_W = {
  count:  { whiff: 1.0, foul: 0.4, out: 0.7, takeIn: 0.6, takeOut: -0.5, single: -1.2, double: -2, hr: -3.5 },
  finish: { whiff: 1.6, foul: 0.2, out: 0.7, takeIn: 0.9, takeOut: -0.25, single: -1.2, double: -2, hr: -3.5 },
};
function pitcherScore(p, takeW, mode = 'count') {
  const w = SCORE_W[mode];
  return p.whiff * w.whiff + p.foul * w.foul + p.out * w.out + p.take * takeW - p.single * -w.single - p.double * -w.double - p.hr * -w.hr;
}
function zoneScores(table, pt, hands, mode = 'count') {
  const w = SCORE_W[mode];
  const out = {};
  for (const z of ZONES) {
    let p = table.probs[`${pt}|${z}|${hands}`];
    if (mode === 'finish' && table.countAdj) p = adjustByCount(p, table.countAdj, 0, 2, z);   // 0-2 상황의 확률로
    out[z] = pitcherScore(p, z <= 9 ? w.takeIn : w.takeOut, mode);
  }
  return out;
}
// 이 조합(좌우)에서 이 공이 4조합 평균보다 좋은가: 존 안 9칸 평균 점수 차
function matchupRating(table, pt, hands) {
  const mean = (h) => { let s = 0; for (let z = 1; z <= 9; z++) s += pitcherScore(table.probs[`${pt}|${z}|${h}`], 0.6); return s / 9; };
  const mine = mean(hands);
  let all = 0; for (const h of HANDS) all += mean(h); all /= 4;
  const diff = mine - all;
  return { diff, label: diff > 0.02 ? '유리' : diff < -0.02 ? '불리' : '보통' };
}
// 앞에 던지면 이 공이 잘 먹는 구종 (표본 충분한 것만, 평균보다 뚜렷이 나은 것만)
function prevAdvice(table, pt, hands, minN = 150, minGain = 0.015) {
  if (!table.byPrev) return [];
  let base = 0, bn = 0;
  const rows = [];
  for (const a of PITCH_TYPES) {
    const r = table.byPrev[`${a}|${pt}|${hands}`];
    if (!r || r.nAll < minN) continue;
    const sc = pitcherScore(r.p, 0.1);
    rows.push({ prev: a, n: r.n, score: sc });
    base += sc * r.nAll; bn += r.nAll;
  }
  if (!bn) return [];
  base /= bn;
  return rows.filter((r) => r.score - base >= minGain).sort((x, y) => y.score - x.score).slice(0, 2)
    .map((r) => ({ prev: r.prev, gain: r.score - base }));
}

function sampleResult(p, rng) {
  let r = rng();
  for (const k of PROB_KEYS) { r -= p[k]; if (r < 0) return k; }
  return PROB_KEYS[PROB_KEYS.length - 1];
}

// ---------- 타자 AI: 노림 ----------
// 타자는 매 구 "어느 계열의 공이 어느 칸으로 올지" 하나를 찍고 기다린다.
//   · 카운트: 3볼(2S 아님)이면 직구 존 안을 노림. 2스트라이크면 넓게 지킴(노림이 약해짐)
//   · 기억: 이 이닝에 투수가 던진 공을 최근 것일수록 무겁게 기억해 그쪽을 노림
// 실제 공이 노림과 얼마나 맞는지(match 0~1)에 따라 결과 확률을 곱해서 바꾼다.
//   맞으면 헛스윙↓ 안타·장타↑, 빗나가면 헛스윙↑ 약한 타구↑.
//   노림이 무작위일 때의 평균 match(m0)를 기준으로 하므로, 읽히지 않는 투수는 실측 그대로다.
const GROUP = { FF: 'fast', SI: 'fast', FC: 'fast', SL: 'break', ST: 'break', CU: 'break', KC: 'break', SV: 'break', CH: 'off', FS: 'off' };
const GROUPS = ['fast', 'break', 'off'];
const GROUP_KO = { fast: '빠른 공', break: '변화구', off: '느린 공' };
const TYPE_MATCH = {
  'fast|fast': 1, 'break|break': 1, 'off|off': 1,
  'fast|break': 0.3, 'break|fast': 0.3, 'fast|off': 0.15, 'off|fast': 0.15, 'break|off': 0.5, 'off|break': 0.5,
};
const AI = {
  memory: 0.7,     // 볼배합 기억 감도 (0 = 기억 없음)
  pattern: 3.0,    // "저 공 다음엔 이 공" 패턴 기억 감도
  decay: 0.7,      // 한 구 전으로 갈수록 곱해지는 가중치
  spread: 0.15,    // 기억한 칸이 이웃 칸으로 번지는 폭 (m)
  focus: 2,        // 노림 뽑기의 집중도 (가중치의 거듭제곱. 클수록 제일 유력한 것에 몰림)
  sigma: 0.22,     // 노린 위치와 실제 위치의 일치 폭 (m)
  base: 0.06,      // 아무 기억이 없을 때 각 (계열, 칸)의 기본 가중치
  sitFast: 2.5,    // 3볼에서 직구 존 안을 노리는 가중치
  protect: 0.7,    // 2스트라이크에서 노림 강도
  effect: { take: -1.8, whiff: -1.8, foul: -0.5, out: 0.3, single: 1.2, double: 1.8, hr: 2.2 },
  hit: 1.35,       // 난이도: 안타·장타 확률 배수 (1 = 실측 평균 타자). 헛스윙은 반대로 나눔
};

// ---------- 타자 9명: 이름은 지어낸 것, 성향은 확률 배수 (설계값) ----------
// take: 안 휘두름, whiff: 헛스윙, single/double/hr: 타구 질, read: 볼배합 읽는 감도(기억·패턴 배수), sit: 노림 강도
const BATTER_TYPES = {
  contact:  { ko: '컨택',    take: 1.0,  whiff: 0.75, single: 1.25, double: 1.0,  hr: 0.7,  read: 1.0, sit: 1.0 },
  patient:  { ko: '잘 참음', take: 1.3,  whiff: 0.9,  single: 1.0,  double: 1.0,  hr: 0.9,  read: 1.0, sit: 0.9 },
  power:    { ko: '장타력',  take: 0.95, whiff: 1.15, single: 0.85, double: 1.25, hr: 1.6,  read: 1.0, sit: 1.1 },
  guess:    { ko: '노림수',  take: 1.0,  whiff: 1.0,  single: 1.0,  double: 1.1,  hr: 1.1,  read: 1.6, sit: 1.3 },
  aggro:    { ko: '적극적',  take: 0.7,  whiff: 1.2,  single: 1.05, double: 1.05, hr: 1.0,  read: 0.8, sit: 0.9 },
  average:  { ko: '평균',    take: 1.0,  whiff: 1.0,  single: 1.0,  double: 1.0,  hr: 1.0,  read: 1.0, sit: 1.0 },
};
// 상대 팀 7개 — 실제 선수 이름·좌우만 쓰고, 성향은 선수 스타일로 배정한 설계값 (실제 기록 데이터 아님).
// 타순은 성향에 맞춰 짬. closer = 플레이어(투수) 이름으로 씀
const B = (name, hand, type, pos) => ({ name, hand, type, pos });
const TEAMS = [
  { key: 'kbo_all', name: 'KBO 역대 최고', closer: '오승환',
    pitchers: [['선동열','R'],['최동원','R'],['류현진','L'],['양현종','L'],['오승환','R']], batters: [
    B('이종범','R','contact','유격'), B('정근우','R','contact','2루'), B('양준혁','L','patient','외야'),
    B('이승엽','L','power','1루'), B('이대호','R','power','지명'), B('최정','R','power','3루'),
    B('최형우','L','power','외야'), B('장효조','L','contact','외야'), B('양의지','R','guess','포수') ] },
  { key: 'nc_all', name: 'NC 다이노스 역대', closer: '임창민',
    pitchers: [['에릭 페디','R'],['드류 루친스키','R'],['구창모','L'],['찰리 쉬렉','R'],['임창민','R']], batters: [
    B('박민우','L','contact','2루'), B('손아섭','L','contact','외야'), B('나성범','L','power','외야'),
    B('에릭 테임즈','L','power','1루'), B('양의지','R','guess','포수'), B('박석민','R','power','3루'),
    B('이호준','R','power','지명'), B('박건우','R','contact','외야'), B('손시헌','R','average','유격') ] },
  { key: 'y2000', name: '2000년대', closer: '오승환',
    pitchers: [['손민한','R'],['류현진','L'],['배영수','R'],['정민태','R'],['오승환','R']], batters: [
    B('정근우','R','contact','2루'), B('이병규','L','contact','외야'), B('양준혁','L','patient','지명'),
    B('이승엽','L','power','1루'), B('심정수','R','power','외야'), B('김동주','R','power','3루'),
    B('박재홍','R','power','외야'), B('박경완','R','guess','포수'), B('박진만','R','average','유격') ] },
  { key: 'y2010', name: '2010년대', closer: '오승환',
    pitchers: [['류현진','L'],['윤석민','R'],['양현종','L'],['더스틴 니퍼트','R'],['오승환','R']], batters: [
    B('서건창','L','contact','2루'), B('손아섭','L','contact','외야'), B('김현수','L','contact','외야'),
    B('박병호','R','power','1루'), B('이대호','R','power','지명'), B('최형우','L','power','외야'),
    B('최정','R','power','3루'), B('양의지','R','guess','포수'), B('김하성','R','average','유격') ] },
  { key: 'y2020', name: '2020년대', closer: '정해영',
    pitchers: [['코디 폰세','R'],['안우진','R'],['원태인','R'],['곽빈','R'],['정해영','R']], batters: [
    B('김혜성','L','contact','2루'), B('이정후','L','contact','외야'), B('김도영','R','power','3루'),
    B('르윈 디아즈','L','power','1루'), B('구자욱','L','power','외야'), B('최정','R','power','지명'),
    B('양의지','R','guess','포수'), B('손아섭','L','contact','외야'), B('오지환','L','average','유격') ] },
  { key: 'y2026', name: '2026 시즌', closer: '곽빈',
    pitchers: [['곽빈','R'],['최민석','R']], batters: [
    B('박찬호','R','aggro','유격'), B('서건창','L','contact','지명'), B('김도영','R','power','외야'),
    B('르윈 디아즈','L','power','1루'), B('구자욱','L','power','외야'), B('최정','R','power','3루'),
    B('양의지','R','guess','포수'), B('빅터 레이예스','L','contact','외야'), B('박준순','R','aggro','2루') ] },
  { key: 'active', name: '현역 최강', closer: '정해영',
    pitchers: [['곽빈','R'],['원태인','R'],['류현진','L'],['임찬규','R'],['정해영','R']], batters: [
    B('박민우','L','contact','2루'), B('손아섭','L','contact','외야'), B('김도영','R','power','3루'),
    B('강백호','L','power','1루'), B('최형우','L','power','지명'), B('구자욱','L','power','외야'),
    B('양의지','R','guess','포수'), B('최정','R','power','3루'), B('박찬호','R','aggro','유격') ] },
];
const LINEUP = TEAMS[0].batters;
function applyBatter(p, type) {
  const t = BATTER_TYPES[type]; if (!t) return p;
  const q = { ...p }; let s = 0;
  q.take *= t.take; q.whiff *= t.whiff; q.single *= t.single; q.double *= t.double; q.hr *= t.hr;
  for (const r of PROB_KEYS) s += q[r];
  for (const r of PROB_KEYS) q[r] /= s;
  return q;
}

function applyDifficulty(p) {
  const h = AI.hit;
  if (h === 1) return p;
  const q = { ...p }; let s = 0;
  q.single *= h; q.double *= h; q.hr *= h; q.whiff /= h;
  for (const r of PROB_KEYS) s += q[r];
  for (const r of PROB_KEYS) q[r] /= s;
  return q;
}

function dist2(a, b) { return (a.x - b.x) ** 2 + (a.z - b.z) ** 2; }

// scout: 이 이닝에 투수가 던진 공들 [{pitchType, zone}] (오래된 것부터)
function chooseExpectation(scout, balls, strikes, rng, read = 1) {
  const cells = ZONES.map((z) => ({ zone: z, pt: zoneTarget(z) }));
  const w = {};
  for (const g of GROUPS) for (const c of cells) w[g + '|' + c.zone] = AI.base;
  const kern = (a, b) => Math.exp(-dist2(a, b) / (2 * AI.spread * AI.spread));
  const add = (s, wt) => {
    if (wt < 0.01) return;
    const g = GROUP[s.pitchType], spt = zoneTarget(s.zone);
    for (const c of cells) w[g + '|' + c.zone] += wt * kern(spt, c.pt);
  };
  const n = scout.length;
  // 기억 1: 최근에 던진 공 (최근일수록 무겁게)
  for (let i = 0; i < n; i++) add(scout[i], read * AI.memory * Math.pow(AI.decay, n - 1 - i));
  // 기억 2: 패턴 — 직전 공과 비슷한 공 뒤에 뭐가 왔었나
  if (n >= 2) {
    const last = scout[n - 1], lpt = zoneTarget(last.zone);
    for (let i = 0; i < n - 1; i++) {
      const prev = scout[i];
      if (GROUP[prev.pitchType] !== GROUP[last.pitchType]) continue;
      const sim = kern(zoneTarget(prev.zone), lpt);
      add(scout[i + 1], read * AI.pattern * sim * Math.pow(AI.decay, (n - 2 - i) * 0.5));
    }
  }
  // 카운트
  let strength = 1;
  if (balls === 3 && strikes < 2) for (const z of [2, 4, 5, 6, 8]) w['fast|' + z] += AI.sitFast;
  if (strikes === 2) strength = AI.protect;
  // 뽑기 (focus 로 유력한 쪽에 몰아줌)
  const keys = Object.keys(w);
  let tot = 0; for (const k of keys) { w[k] = Math.pow(w[k], AI.focus); tot += w[k]; }
  let r = rng() * tot, pick = keys[keys.length - 1];
  for (const k of keys) { r -= w[k]; if (r < 0) { pick = k; break; } }
  const [group, zs] = pick.split('|');
  const zone = Number(zs), pt = zoneTarget(zone);
  return { group, zone, x: pt.x, z: pt.z, strength };
}

function matchScore(expect, pitchType, x, z) {
  const tm = TYPE_MATCH[expect.group + '|' + GROUP[pitchType]];
  const d2 = (x - expect.x) ** 2 + (z - expect.z) ** 2;
  return tm * Math.exp(-d2 / (2 * AI.sigma * AI.sigma));
}

// 노림이 무작위였을 때의 평균 match — 이 값이 기준선
function baselineMatch(pitchType, x, z) {
  let s = 0, n = 0;
  for (const g of GROUPS) for (const zone of ZONES) {
    const pt = zoneTarget(zone);
    s += matchScore({ group: g, x: pt.x, z: pt.z }, pitchType, x, z); n++;
  }
  return s / n;
}

function applyExpectation(p, m, m0, strength) {
  const q = {}; let s = 0;
  for (const r of PROB_KEYS) { q[r] = p[r] * Math.exp(AI.effect[r] * strength * (m - m0)); s += q[r]; }
  for (const r of PROB_KEYS) q[r] /= s;
  return q;
}

// ---------- 타석 (투구 하나씩) ----------
function startPA(hands) {
  return { balls: 0, strikes: 0, hands, history: [], outcome: null };
}

// 투구 하나. pick = { pitchType, zone }
// 옵션: wobble (기본 true), wobbleScale, countAdjust (기본 true), rng,
//       judge(x, z) → true=스트라이크 : 안 휘두른 공의 볼/루킹을 가르는 판정 (도감 ABS를 넘겨줌)
//       ai (기본 true) 타자 노림 켜기, scout: 이 이닝의 투구 기록 배열 (넘기면 여기에 쌓임), expect: 노림을 직접 지정
// 반환 rec: { pitchType, aim, zone, x, z, result, count, outcome, expect, match, swung }  outcome 은 타석이 끝났을 때만
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
  const bt = BATTER_TYPES[opts.batter] || BATTER_TYPES.average;
  let expect = null, match = null;
  if (opts.ai !== false) {
    expect = opts.expect || chooseExpectation(opts.scout || [], st.balls, st.strikes, rng, bt.read);
    match = matchScore(expect, pick.pitchType, land.x, land.z);
    const m0 = baselineMatch(pick.pitchType, land.x, land.z);
    p = applyExpectation(p, match, m0, (expect.strength || 1) * bt.sit);
  }
  if (opts.batter) p = applyBatter(p, opts.batter);
  p = applyDifficulty(p);
  let result = sampleResult(p, rng);
  if (result === 'take') {
    const strike = opts.judge ? opts.judge(land.x, land.z) : land.zone <= 9;
    result = strike ? 'called' : 'ball';
  }

  const rec = { pitchType: pick.pitchType, aim: pick.zone, zone: land.zone, x: land.x, z: land.z,
                result, count: `${st.balls}-${st.strikes}`, outcome: null,
                expect, match, swung: result !== 'ball' && result !== 'called' };

  if (IN_PLAY.has(result)) rec.outcome = result;
  else if (result === 'ball') { st.balls++; if (st.balls === 4) rec.outcome = 'walk'; }
  else if (result === 'foul') { if (st.strikes < 2) st.strikes++; }
  else { st.strikes++; if (st.strikes === 3) rec.outcome = 'strikeout'; }

  st.history.push(rec);
  if (opts.scout) opts.scout.push(rec);
  if (rec.outcome) st.outcome = rec.outcome;
  return rec;
}

// 타석 하나를 끝까지. choose(state) → { pitchType, zone }
function simulatePA(table, hands, choose, opts = {}) {
  const st = startPA(hands);
  if (opts.ai !== false && !opts.scout) opts = { ...opts, scout: [] };
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

// 시작 상황: 9회말 3:2 리드, 1사 1·2루. 3아웃까지 리드를 지키면 승리, 역전당하면 패배,
// 동점으로 끝나면 연장 (10회부터 승부치기: 무사 2루). 12회까지 동점이면 무승부.
const START = { outs: 1, bases: [true, true, false] }; // [1루, 2루, 3루]
const EXTRA_START = { outs: 0, bases: [false, true, false] };
const MAX_INNING = 12;
const TOP_RUNS = [[0, 0.55], [1, 0.30], [2, 0.15]];   // 연장 초 우리 공격 득점 (승부치기 실측 근처)

function startInning(inning = 9) {
  const s = inning >= 10 ? EXTRA_START : START;
  return { inning, outs: s.outs, bases: s.bases.slice(), runs: 0 };
}

// 경기 전체: 점수판 + 현재 이닝
function startGame() {
  return { us: 3, them: 2, inn: startInning(9), topRuns: null, log: [] };
}
// 'playing' | 'win' | 'lose' | 'tied'(이닝 끝, 연장으로) | 'draw'
function gameStatus(g) {
  const them = g.them + g.inn.runs;
  if (them > g.us) return 'lose';
  if (g.inn.outs >= 3) {
    if (g.us > them) return 'win';
    return g.inn.inning >= MAX_INNING ? 'draw' : 'tied';
  }
  return 'playing';
}
// 동점 이닝을 닫고 다음 이닝으로 (우리 공격은 확률로)
function nextInning(g, rng = Math.random) {
  g.them += g.inn.runs;
  const r = rng();
  let acc = 0, top = 0;
  for (const [n, p] of TOP_RUNS) { acc += p; if (r < acc) { top = n; break; } }
  g.us += top; g.topRuns = top;
  g.inn = startInning(g.inn.inning + 1);
  return top;
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

function inningOver(st) { return st.outs >= 3; }

// 경기 하나 (연장 포함). batterHands(i) → 'R' | 'L' (i번째 타자, 타순 이어짐), choose(state) → {pitchType, zone}
// 반환: { result: 'win'|'lose'|'draw', innings, pas, us, them }
function simulateGame(table, pitcherHand, batterHands, choose, opts = {}) {
  const rng = opts.rng || Math.random;
  const g = startGame();
  const pas = [];
  const paOpts = { ...opts, scout: opts.scout || [] };
  let i = 0, status;
  for (;;) {
    const b = opts.lineup ? opts.lineup[i % opts.lineup.length] : null;
    const hands = pitcherHand + (b ? b.hand : batterHands(i));
    if (b) paOpts.batter = b.type;
    i++;
    const pa = simulatePA(table, hands, choose, paOpts);
    const r = applyOutcome(g.inn, pa.outcome, rng);
    pas.push({ inning: g.inn.inning, hands, outcome: pa.outcome, pitches: pa.pitches, runs: r, outs: g.inn.outs, bases: g.inn.bases.slice() });
    status = gameStatus(g);
    if (status === 'tied') { nextInning(g, rng); continue; }
    if (status !== 'playing') break;
  }
  return { result: status, won: status === 'win', innings: g.inn.inning, pas, us: g.us, them: g.them + g.inn.runs };
}
// 예전 이름 (9회만 보는 검증용): 무실점이면 승
function simulateInning(table, pitcherHand, batterHands, choose, opts = {}) {
  const r = simulateGame(table, pitcherHand, batterHands, choose, opts);
  const ninth = r.pas.filter((p) => p.inning === 9);
  const runs = ninth.reduce((s, p) => s + p.runs, 0);
  return { won: runs === 0, runs, pas: ninth, outs: ninth.length ? ninth[ninth.length - 1].outs : 0, game: r };
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
  SCORE_W, pitcherScore, zoneScores, matchupRating, prevAdvice,
  GROUP, GROUPS, GROUP_KO, AI, BATTER_TYPES, TEAMS, LINEUP, applyBatter, chooseExpectation, matchScore, baselineMatch, applyExpectation,
  startPA, throwPitch, simulatePA,
  RUNNER_RULES, START, EXTRA_START, MAX_INNING, startInning, startGame, gameStatus, nextInning,
  applyOutcome, inningOver, simulateGame, simulateInning,
  makeUsagePolicy, fixedPolicy, randomPolicy, mulberry32,
};
}));
