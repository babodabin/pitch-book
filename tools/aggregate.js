#!/usr/bin/env node
// 한 이닝 게임 1단계 — Statcast CSV → 520칸 집계표
//
// 사용법:  node tools/aggregate.js            (data/*.csv 전부 합쳐서 집계)
//          node tools/aggregate.js 파일1 파일2 (지정한 파일만)
//
// 출력:   data/out/pitch_table.json   앱용 (칸별 결과 건수)
//         data/out/pitch_table.csv    검토용 (한 줄 = 한 칸, 건수 + 비율)
//         콘솔                        파일별 구수 · 제외 내역 · 표본 분포
//
// 집계 키:  구종 10종 × zone 13칸 × 투수 좌우 × 타자 좌우 = 520칸 (카운트 분리 없음)
// 결과 8종: ball / called / whiff / foul / out / single / double / hr
//
// 분류 규칙 (한이닝게임_기획.md 기준)
//   볼    : ball, blocked_ball            — 단, zone 1~9면 called 로 재분류(오심 정리, ABS 기준)
//   루킹  : called_strike                 — 단, zone 11~14면 ball 로 재분류
//   헛스윙: swinging_strike, swinging_strike_blocked, foul_tip
//   파울  : foul
//   인플레이(hit_into_play) → events 로 세분
//     out   : field_out, force_out, grounded_into_double_play, double_play,
//             fielders_choice, fielders_choice_out, sac_fly, sac_fly_double_play,
//             field_error (게임에 실책 개념 없음 → 잡혔어야 할 공)
//     single: single
//     double: double, triple (3루타는 2루타에 합침)
//     hr    : home_run
//   제외: 구종 10종 밖(공란, EP, CS, KN …), zone 없음, 사구, automatic_ball/strike,
//         번트(foul_bunt, missed_bunt, bunt_foul_tip, sac_bunt, des 에 "bunt"),
//         그 밖의 정체불명 description/events
//   중복: (game_pk, at_bat_number, pitch_number) 같으면 한 번만 셈

'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(DATA_DIR, 'out');

const PITCH_TYPES = ['FF', 'SI', 'FC', 'SL', 'ST', 'CU', 'KC', 'CH', 'FS', 'SV'];
const ZONES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14];
const HANDS = ['RR', 'RL', 'LR', 'LL']; // 투수 + 타자
const RESULTS = ['ball', 'called', 'whiff', 'foul', 'out', 'single', 'double', 'hr'];

const OUT_EVENTS = new Set([
  'field_out', 'force_out', 'grounded_into_double_play', 'double_play',
  'fielders_choice', 'fielders_choice_out', 'sac_fly', 'sac_fly_double_play',
  'field_error',
]);
const BUNT_DESC = new Set(['foul_bunt', 'missed_bunt', 'bunt_foul_tip']);

// ---------- CSV 파싱 (따옴표 안의 콤마·줄바꿈 처리) ----------
function splitCsvLine(line) {
  const out = [];
  let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { f += '"'; i++; } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(f); f = ''; }
    else f += c;
  }
  out.push(f);
  return out;
}

function countQuotes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '"') n++;
  return n;
}

// 파일을 한 줄씩 읽어 row(object)마다 onRow 호출
async function readCsv(file, onRow) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let header = null, pending = '';
  for await (const raw of rl) {
    const line = pending ? pending + '\n' + raw : raw;
    if (countQuotes(line) % 2 === 1) { pending = line; continue; } // 따옴표 열린 채 줄바꿈
    pending = '';
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    if (!header) {
      header = cells.map((h) => h.replace(/^﻿/, '').trim());
      // Statcast 원본이 아니면(집계 결과 파일 등) 통째로 건너뜀
      if (!header.includes('description') || !header.includes('p_throws')) {
        console.log(`  (건너뜀: Statcast 형식 아님) ${path.basename(file)}`);
        rl.close();
        return;
      }
      continue;
    }
    if (cells.length !== header.length) continue; // 깨진 줄
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i];
    onRow(row);
  }
}

// ---------- 한 투구 분류 ----------
// 반환: { result } 또는 { skip: 사유 }
function classify(row) {
  const pt = row.pitch_type;
  if (!PITCH_TYPES.includes(pt)) return { skip: 'pitch_type:' + (pt || '(공란)') };
  const zone = Number(row.zone);
  if (!ZONES.includes(zone)) return { skip: 'zone:' + (row.zone || '(공란)') };
  if (!'RL'.includes(row.p_throws) || !'RL'.includes(row.stand) || !row.p_throws || !row.stand)
    return { skip: 'hand' };

  const d = row.description;
  const ev = row.events;
  const des = (row.des || '').toLowerCase();

  if (BUNT_DESC.has(d) || ev === 'sac_bunt' || (d === 'hit_into_play' && des.includes('bunt')))
    return { skip: 'bunt' };

  switch (d) {
    case 'ball':
    case 'blocked_ball':
      return { result: zone <= 9 ? 'called' : 'ball' };
    case 'called_strike':
      return { result: zone <= 9 ? 'called' : 'ball' };
    case 'swinging_strike':
    case 'swinging_strike_blocked':
    case 'foul_tip':
      return { result: 'whiff' };
    case 'foul':
      return { result: 'foul' };
    case 'hit_into_play':
      if (OUT_EVENTS.has(ev)) return { result: 'out' };
      if (ev === 'single') return { result: 'single' };
      if (ev === 'double' || ev === 'triple') return { result: 'double' };
      if (ev === 'home_run') return { result: 'hr' };
      return { skip: 'events:' + (ev || '(공란)') };
    case 'hit_by_pitch':
    case 'automatic_ball':
    case 'automatic_strike':
    case 'pitchout':
      return { skip: d };
    default:
      return { skip: 'description:' + d };
  }
}

// ---------- 집계 ----------
function emptyCell() {
  const c = { n: 0 };
  for (const r of RESULTS) c[r] = 0;
  return c;
}

async function main() {
  let files = process.argv.slice(2);
  if (files.length === 0) {
    if (!fs.existsSync(DATA_DIR)) { console.error('data/ 폴더가 없습니다.'); process.exit(1); }
    files = fs.readdirSync(DATA_DIR)
      .filter((f) => f.toLowerCase().endsWith('.csv'))
      .sort()
      .map((f) => path.join(DATA_DIR, f));
  }
  if (files.length === 0) { console.error('집계할 CSV가 없습니다.'); process.exit(1); }

  const cells = {};
  for (const pt of PITCH_TYPES) for (const z of ZONES) for (const h of HANDS)
    cells[`${pt}|${z}|${h}`] = emptyCell();

  const seen = new Set();
  const skipped = {};
  // 실제 타석 결과 (2단계 검증 기준치): 타석이 끝난 투구의 events 를 셈
  const paRef = { pa: 0, pitches: 0, walk: 0, strikeout: 0, out: 0, single: 0, double: 0, hr: 0 };
  const PA_MAP = {
    walk: 'walk', intent_walk: 'walk',
    strikeout: 'strikeout', strikeout_double_play: 'strikeout',
    single: 'single', double: 'double', triple: 'double', home_run: 'hr',
  };
  for (const e of OUT_EVENTS) PA_MAP[e] = 'out';
  // 카운트별 결과 분포 (카운트 보정용): "볼-스트라이크|in/out" → 결과 8종 건수
  // 존 안/밖을 갈라야 "그 카운트에 투수가 어디 던졌나"가 보정에 섞이지 않는다
  const byCount = {};
  for (let b = 0; b < 4; b++) for (let st = 0; st < 3; st++) for (const io of ['in', 'out'])
    byCount[`${b}-${st}|${io}`] = emptyCell();
  const fileStats = [];
  let totalRows = 0, dupes = 0, used = 0;
  // 앞 공 → 이 공: 같은 타석에서 바로 앞에 던진 구종별로 이 공의 결과를 센다 (타석 단위로 모아뒀다 계산)
  const paPitches = new Map();   // game_pk|at_bat_number → [{no, pt, result}]
  const byPrev = {};
  for (const a of PITCH_TYPES) for (const b of PITCH_TYPES) for (const h of [...HANDS, 'ALL']) byPrev[`${a}|${b}|${h}`] = emptyCell();

  for (const file of files) {
    let rows = 0, kept = 0;
    const dates = new Set();
    await readCsv(file, (row) => {
      rows++; totalRows++;
      const id = `${row.game_pk}|${row.at_bat_number}|${row.pitch_number}`;
      if (seen.has(id)) { dupes++; return; }
      seen.add(id);
      if (row.game_date) dates.add(row.game_date);
      if (row.events && PA_MAP[row.events] && row.events !== 'sac_bunt') {
        paRef.pa++; paRef[PA_MAP[row.events]]++; paRef.pitches += Number(row.pitch_number) || 0;
      }
      const c = classify(row);
      if (c.skip) { skipped[c.skip] = (skipped[c.skip] || 0) + 1; return; }
      const paKey = `${row.game_pk}|${row.at_bat_number}`;
      if (!paPitches.has(paKey)) paPitches.set(paKey, []);
      paPitches.get(paKey).push({ no: Number(row.pitch_number), pt: row.pitch_type, result: c.result, hands: row.p_throws + row.stand });
      const key = `${row.pitch_type}|${row.zone}|${row.p_throws}${row.stand}`;
      cells[key].n++;
      cells[key][c.result]++;
      const cnt = byCount[`${row.balls}-${row.strikes}|${Number(row.zone) <= 9 ? 'in' : 'out'}`];
      if (cnt) { cnt.n++; cnt[c.result]++; }
      kept++; used++;
    });
    const ds = [...dates].sort();
    fileStats.push({ file: path.basename(file), rows, kept, from: ds[0] || '', to: ds[ds.length - 1] || '' });
  }

  for (const list of paPitches.values()) {
    list.sort((a, b) => a.no - b.no);
    for (let i = 1; i < list.length; i++) {
      if (list[i].no !== list[i - 1].no + 1) continue;   // 사이에 제외된 공이 있으면 건너뜀
      for (const h of [list[i].hands, 'ALL']) {
        const c = byPrev[`${list[i - 1].pt}|${list[i].pt}|${h}`];
        c.n++; c[list[i].result]++;
      }
    }
  }

  // ---------- 출력 ----------
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const json = {
    generated: new Date().toISOString().slice(0, 10),
    files: fileStats,
    pitches: used,
    pa_reference: paRef,
    by_count: byCount,
    by_prev: byPrev,
    key: 'pitch_type|zone|p_throws+stand',
    results: RESULTS,
    pitch_types: PITCH_TYPES,
    zones: ZONES,
    hands: HANDS,
    cells,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'pitch_table.json'), JSON.stringify(json));

  const csvLines = [['pitch_type', 'zone', 'hand', 'n', ...RESULTS, ...RESULTS.map((r) => r + '_pct')].join(',')];
  for (const pt of PITCH_TYPES) for (const z of ZONES) for (const h of HANDS) {
    const c = cells[`${pt}|${z}|${h}`];
    const pct = RESULTS.map((r) => (c.n ? (c[r] / c.n * 100).toFixed(1) : ''));
    csvLines.push([pt, z, h, c.n, ...RESULTS.map((r) => c[r]), ...pct].join(','));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'pitch_table.csv'), csvLines.join('\n') + '\n');

  // ---------- 콘솔 요약 ----------
  console.log('== 파일');
  for (const f of fileStats) console.log(`  ${f.file}  ${f.from}~${f.to}  ${f.rows}구 → ${f.kept}구 사용`);
  console.log(`  합계 ${totalRows}구, 중복 ${dupes}, 사용 ${used}`);

  console.log('== 제외');
  for (const [k, v] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(30)} ${v}`);

  const tot = emptyCell();
  for (const c of Object.values(cells)) { tot.n += c.n; for (const r of RESULTS) tot[r] += c[r]; }
  console.log('== 결과 분포 (전체)');
  for (const r of RESULTS) console.log(`  ${r.padEnd(8)} ${String(tot[r]).padStart(7)}  ${(tot[r] / tot.n * 100).toFixed(1)}%`);

  console.log('== 실제 타석 결과 (검증 기준치)');
  console.log(`  타석 ${paRef.pa}, 타석당 ${(paRef.pitches / paRef.pa).toFixed(2)}구`);
  for (const k of ['walk', 'strikeout', 'out', 'single', 'double', 'hr'])
    console.log(`  ${k.padEnd(10)} ${String(paRef[k]).padStart(7)}  ${(paRef[k] / paRef.pa * 100).toFixed(1)}%`);

  console.log('== 카운트별 결과 (보정용)');
  console.log('  카운트   구수 ' + RESULTS.map((r) => r.padStart(7)).join(''));
  for (const [k, c] of Object.entries(byCount))
    console.log(`  ${k}   ${String(c.n).padStart(6)} ` + RESULTS.map((r) => (c[r] / c.n * 100).toFixed(1).padStart(6) + '%').join(''));

  console.log('== 구종별 구수');
  for (const pt of PITCH_TYPES) {
    let n = 0;
    for (const z of ZONES) for (const h of HANDS) n += cells[`${pt}|${z}|${h}`].n;
    console.log(`  ${pt}  ${n}`);
  }

  console.log('== 칸당 표본 (520칸, 목표 200구)');
  const ns = Object.values(cells).map((c) => c.n).sort((a, b) => a - b);
  const bucket = (lo, hi) => ns.filter((n) => n >= lo && n < hi).length;
  console.log(`  0구        ${bucket(0, 1)}칸`);
  console.log(`  1~19구     ${bucket(1, 20)}칸`);
  console.log(`  20~49구    ${bucket(20, 50)}칸`);
  console.log(`  50~199구   ${bucket(50, 200)}칸`);
  console.log(`  200구 이상 ${bucket(200, Infinity)}칸`);
  console.log(`  최소 ${ns[0]} / 중앙값 ${ns[ns.length >> 1]} / 최대 ${ns[ns.length - 1]}`);

  console.log(`\n→ ${path.relative(ROOT, path.join(OUT_DIR, 'pitch_table.json'))}, pitch_table.csv 저장`);
}

main().catch((e) => { console.error(e); process.exit(1); });
