/**
 * QA pass over the parsed corpus. Catches the failure mode that matters most:
 * a parser that "succeeds" while writing partial or wrong data.
 *
 *   node scripts/validate.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const FACTS = 'data/facts', RAW = 'data/raw';
const universe = JSON.parse(readFileSync('symbols.json', 'utf8'));

const parsed = existsSync(FACTS)
  ? readdirSync(FACTS).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
  : [];
const archived = existsSync(RAW)
  ? readdirSync(RAW).filter(s => existsSync(`${RAW}/${s}`) &&
      readdirSync(`${RAW}/${s}`).some(f => f.endsWith('.html.gz')))
  : [];

const docs = parsed.map(s => JSON.parse(readFileSync(`${FACTS}/${s}.json`, 'utf8')));

console.log('COVERAGE');
console.log(`  universe          ${universe.length}`);
console.log(`  pages archived    ${archived.length}`);
console.log(`  facts parsed      ${parsed.length}`);
const missing = universe.filter(s => !archived.includes(s));
if (missing.length) console.log(`  NOT ARCHIVED (${missing.length}): ${missing.join(', ')}`);

console.log('\nVARIANT');
const byVariant = {};
for (const d of docs) byVariant[d.variant] = (byVariant[d.variant] || 0) + 1;
for (const [k, v] of Object.entries(byVariant)) console.log(`  ${k.padEnd(14)} ${v}`);

console.log('\nFRESHNESS (latest quarter present)');
const byQ = {};
for (const d of docs) byQ[d.latestQuarter] = (byQ[d.latestQuarter] || 0) + 1;
for (const [k, v] of Object.entries(byQ).sort()) console.log(`  ${String(k).padEnd(14)} ${v}`);

console.log('\nFACT COUNTS');
const counts = docs.map(d => d.factCount).sort((a, b) => a - b);
const pct = p => counts[Math.floor(counts.length * p)] ?? 0;
console.log(`  min ${counts[0]}  p10 ${pct(0.1)}  median ${pct(0.5)}  p90 ${pct(0.9)}  max ${counts[counts.length - 1]}`);
const thin = docs.filter(d => d.factCount < 150).map(d => `${d.symbol}(${d.factCount})`);
if (thin.length) console.log(`  THIN - inspect these: ${thin.join(', ')}`);

console.log('\nLINE-ITEM VOCABULARY  (statement :: label -> how many companies)');
const vocab = {};
for (const d of docs) {
  const seen = new Set(d.facts.map(f => `${f.statement} :: ${f.lineItem}`));
  for (const k of seen) vocab[k] = (vocab[k] || 0) + 1;
}
const entries = Object.entries(vocab).sort((a, b) => b[1] - a[1]);
const common = entries.filter(([, n]) => n >= docs.length * 0.5);
const sector = entries.filter(([, n]) => n < docs.length * 0.5 && n >= 5);
const rare   = entries.filter(([, n]) => n < 5);
console.log(`  universal (>=50% of companies): ${common.length} labels`);
console.log(`  sector-specific (5..50%):       ${sector.length} labels`);
for (const [k, n] of sector.slice(0, 18)) console.log(`      ${String(n).padStart(3)}  ${k}`);
if (rare.length) {
  console.log(`  RARE (<5 companies) - likely parse artifacts, review:`);
  for (const [k, n] of rare.slice(0, 15)) console.log(`      ${String(n).padStart(3)}  ${k}`);
}

console.log('\nWARNINGS');
const warned = docs.filter(d => d.warnings?.length);
console.log(`  ${warned.length} symbols carry warnings`);
for (const d of warned.slice(0, 15)) console.log(`      ${d.symbol}: ${d.warnings.join(' | ')}`);

if (existsSync('data/state/unresolved.txt')) {
  const u = readFileSync('data/state/unresolved.txt', 'utf8').split('\n').filter(Boolean);
  console.log(`\nUNRESOLVED SLUGS (${u.length}): ${u.join(', ')}`);
}
