#!/bin/sh
# savant_받을목록.html 의 11개 링크를 data/ 에 받는다. 이미 있는 파일은 건너뜀.
cd "$(dirname "$0")/.." || exit 1
BASE="https://baseballsavant.mlb.com/statcast_search/csv?all=true&type=details&hfGT=R%7C&player_type=pitcher&min_pitches=0&min_results=0&group_by=name&sort_col=pitches&player_event_sort=api_p_release_speed&sort_order=desc"
i=0
while read -r y from to; do
  i=$((i+1))
  out=$(printf 'data/savant_%02d_%s_%s.csv' "$i" "$y" "$from")
  if [ -s "$out" ]; then echo "있음  $out"; continue; fi
  printf '받는 중 %s ... ' "$out"
  if curl -sS -m 300 -o "$out.part" </dev/null "$BASE&hfSea=$y%7C&game_date_gt=$y-$from&game_date_lt=$y-$to" \
     && head -c 200 "$out.part" | grep -q 'pitch_type'; then
    mv "$out.part" "$out"; echo "$(wc -l < "$out")줄"
  else
    rm -f "$out.part"; echo "실패"
  fi
done <<LIST
2026 06-05 06-08
2026 07-10 07-13
2026 08-14 08-17
2025 04-11 04-14
2025 06-06 06-09
2025 07-18 07-21
2025 08-15 08-18
2024 04-12 04-15
2024 06-07 06-10
2024 07-19 07-22
2024 08-16 08-19
LIST
