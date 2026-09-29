// 구종별 평균 속임 효과(D) — 실제 사용 빈도대로 던졌을 때. 결과를 engine.js DECEPT.base 에 넣는다 (확률표가 바뀌면 다시 돌릴 것)
const fs=require('fs'), path=require('path');
const E=require('./engine');
const t=E.buildTable(JSON.parse(fs.readFileSync(path.join(__dirname,'../data/out/pitch_table.json'),'utf8')));
const rng=E.mulberry32(42);
const sum={}, n={};
for(const h of E.HANDS){
  for(let i=0;i<15000;i++){
    const r=E.simulatePA(t,h,E.makeUsagePolicy(t,h,rng),{rng,ai:false});
    for(const p of r.pitches){ if(p.effect && p.effect.D!==undefined){ sum[p.pitchType]=(sum[p.pitchType]||0)+p.effect.D; n[p.pitchType]=(n[p.pitchType]||0)+1; } }
  }
}
const base={}; for(const k of E.PITCH_TYPES) base[k]=+(sum[k]/n[k]).toFixed(3);
console.log(JSON.stringify(base));
