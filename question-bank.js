// 문제 저장소: Claude가 만든 문제를 파일에 쌓아 두고 다시 꺼내 씁니다.
//  - 한 번 만든 문제는 계속 재사용하므로 API 비용이 늘지 않고, Claude가 느리거나 막혀도 게임이 이어집니다.
//  - 파일 위치는 환경변수 BANK_FILE로 바꿀 수 있습니다. (호스팅이 재시작 때 디스크를 지운다면 영구 디스크 경로로 지정하세요)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BANK_FILE = process.env.BANK_FILE || path.join(__dirname, 'question-bank.json');
const LEVELS = ['easy', 'medium', 'hard'];
// 저장소가 너무 커지지 않게 상한을 둡니다. 넘으면 가장 오래된 문제부터 지웁니다.
const MAX_FACTS = 3000, MAX_LIT_PER_LEVEL = 1500;
// 저장된 문제가 이 수 이상 쌓이면 대부분의 요청을 저장소에서 바로 처리합니다. (환경변수로 조정 가능)
const MIN_FACTS = Number(process.env.BANK_MIN_FACTS) || 150;
const MIN_LIT = Number(process.env.BANK_MIN_LIT) || 60;
// 저장소가 충분해도 이 비율만큼은 새 문제를 만들어 저장소를 조금씩 키웁니다. (0이면 새로 만들지 않음)
const FRESH_RATE = process.env.BANK_FRESH_RATE !== undefined && process.env.BANK_FRESH_RATE !== '' ? Math.min(1, Math.max(0, Number(process.env.BANK_FRESH_RATE))) : 0.15;

const norm = s => String(s || '').toLocaleLowerCase('ko-KR').replace(/[\s.,!?'"~·\-_()[\]]/g, '');

const data = { facts: [], lit: { easy: [], medium: [], hard: [] } };
try {
  const saved = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8'));
  if (Array.isArray(saved.facts)) data.facts = saved.facts.filter(i => i && i.text && i.why);
  for (const lv of LEVELS) if (Array.isArray(saved.lit?.[lv])) data.lit[lv] = saved.lit[lv].filter(i => i && i.q && Array.isArray(i.a) && i.a.length === 2);
} catch (e) { if (e.code !== 'ENOENT') console.error('question-bank.json 읽기 실패(새로 시작합니다):', e.message); }

// 이미 들어 있는 문제인지 빠르게 보기 위한 색인 (문장 정규화 기준)
const seen = { facts: new Set(data.facts.map(i => norm(i.text))), lit: new Set(LEVELS.flatMap(lv => data.lit[lv].map(i => norm(i.q)))) };

let timer = null, dirty = false;
function writeNow() {
  dirty = false;
  const tmp = BANK_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, BANK_FILE);
}
function save() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; try { writeNow(); } catch (e) { console.error('question-bank.json 저장 실패:', e.message); } }, 3000);
}
// 서버가 꺼질 때 아직 저장 안 된 문제가 있으면 마저 저장합니다.
process.on('exit', () => { if (dirty) { try { writeNow(); } catch { /* 종료 중이라 무시 */ } } });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));

function trim(list, kind, max) {
  while (list.length > max) {
    const old = list.shift();
    seen[kind].delete(norm(kind === 'facts' ? old.text : old.q));
  }
}

// 새로 만든 문제를 저장합니다. 이미 있는 문제는 건너뜁니다.
function addFacts(items) {
  let added = 0;
  for (const it of items || []) {
    const key = norm(it.text);
    if (!key || seen.facts.has(key)) continue;
    seen.facts.add(key); data.facts.push({ text: it.text, answer: it.answer, why: it.why, u: 0 }); added++;
  }
  if (added) { trim(data.facts, 'facts', MAX_FACTS); save(); }
  return added;
}
function addLit(level, items) {
  const lv = LEVELS.includes(level) ? level : 'medium';
  let added = 0;
  for (const it of items || []) {
    const key = norm(it.q);
    if (!key || seen.lit.has(key)) continue;
    seen.lit.add(key); data.lit[lv].push({ q: it.q, a: it.a, c: it.c, e: it.e, u: 0 }); added++;
  }
  if (added) { trim(data.lit[lv], 'lit', MAX_LIT_PER_LEVEL); save(); }
  return added;
}

// 저장된 문제 중 덜 쓰인 것부터 무작위로 count개를 꺼냅니다. avoid에 있는 문장(이미 본 문제)은 뺍니다.
function pick(list, count, avoid, textOf) {
  const skip = new Set((avoid || []).map(norm));
  const pool = list.filter(i => !skip.has(norm(textOf(i))));
  for (let i = pool.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  pool.sort((x, y) => (x.u || 0) - (y.u || 0)); // 정렬은 안정적이라 같은 횟수끼리는 위에서 섞은 순서를 유지합니다
  const out = pool.slice(0, count);
  out.forEach(i => { i.u = (i.u || 0) + 1; });
  if (out.length) save();
  return out;
}
function sampleFacts(count, avoid) {
  return pick(data.facts, count, avoid, i => i.text).map(i => ({ text: i.text, answer: i.answer, why: i.why }));
}
function sampleLit(level, count, avoid) {
  const lv = LEVELS.includes(level) ? level : 'medium';
  return pick(data.lit[lv], count, avoid, i => i.q).map(i => {
    // 다시 낼 때는 정답 위치를 새로 섞어서, 같은 문제여도 외운 위치로 맞히지 못하게 합니다.
    const flip = crypto.randomInt(2) === 0;
    return { q: i.q, a: flip ? [i.a[1], i.a[0]] : [i.a[0], i.a[1]], c: flip ? 1 - i.c : i.c, e: i.e };
  });
}

const sizeFacts = () => data.facts.length;
const sizeLit = level => data.lit[LEVELS.includes(level) ? level : 'medium'].length;
// 저장소가 충분히 쌓였는가? (그렇다면 요청 대부분을 저장소에서 처리)
const readyFacts = () => data.facts.length >= MIN_FACTS;
const readyLit = level => sizeLit(level) >= MIN_LIT;
// 이번 요청을 저장소에서 처리할지 정합니다. (FRESH_RATE만큼은 새로 만들어 저장소를 키웁니다)
const useBank = () => crypto.randomInt(1000) >= FRESH_RATE * 1000;

module.exports = { addFacts, addLit, sampleFacts, sampleLit, sizeFacts, sizeLit, readyFacts, readyLit, useBank, stats: () => ({ facts: data.facts.length, lit: Object.fromEntries(LEVELS.map(l => [l, data.lit[l].length])) }) };
