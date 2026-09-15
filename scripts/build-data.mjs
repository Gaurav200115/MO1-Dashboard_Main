/**
 * Emit the app's data layer from the parsed fact corpus.
 *
 *   node scripts/build-data.mjs
 *
 * Writes:
 *   app/public/data/index.json          light list - drives the table + leaders
 *   app/public/data/companies/{SYM}.json full statements - fetched on row open
 *
 * Split deliberately: the index stays small enough to ship on first paint,
 * and statement history loads only for the company actually being inspected.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// resolve everything against the repo root so the script runs from any cwd
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => join(ROOT, ...p);

const FACTS = R('data/facts');
const OUT = R('app/public/data');
const index = JSON.parse(readFileSync(R('nifty200.json'), 'utf8'));
const sectorOf = Object.fromEntries(index.constituents.map(c => [c.symbol, c.sector]));
const nameOf = Object.fromEntries(index.constituents.map(c => [c.symbol, c.name]));

const calendarPath = R('data/state/results_calendar.json');
const calendar = existsSync(calendarPath) ? JSON.parse(readFileSync(calendarPath, 'utf8')) : {};

const money = s => {
  if (!s) return null;
  const t = String(s).replace(/[₹,\s]/g, '').replace(/Cr\.?$/i, '').replace('%', '');
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
};
const r2 = v => (v == null || !Number.isFinite(v)) ? null : Math.round(v * 100) / 100;

/** Quarter after `ym`, plus its SEBI LODR Reg 33 filing deadline (45d, 60d for Q4). */
function expectedResults(ym) {
  if (!ym) return null;
  let [y, m] = ym.split('-').map(Number);
  m += 3;
  if (m > 12) { m -= 12; y += 1; }
  const qEnd = new Date(Date.UTC(y, m, 0));
  const due = new Date(qEnd.getTime() + (m === 3 ? 60 : 45) * 86400000);
  return { quarterEnd: qEnd.toISOString().slice(0, 10), dueBy: due.toISOString().slice(0, 10) };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/companies`, { recursive: true });

const list = [];
const symbols = readdirSync(FACTS).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));

for (const sym of symbols) {
  const d = JSON.parse(readFileSync(`${FACTS}/${sym}.json`, 'utf8'));
  const t = d.topRatios || {};

  const series = {};
  for (const f of d.facts) {
    if (f.statement === 'growth') continue;
    const s = (series[f.statement] ||= { periods: [], rows: {} });
    if (!s.periods.includes(f.periodEnd)) s.periods.push(f.periodEnd);
  }
  for (const k of Object.keys(series)) {
    series[k].periods.sort((a, b) => (a === 'TTM') - (b === 'TTM') || a.localeCompare(b));
  }
  for (const f of d.facts) {
    if (f.statement === 'growth') continue;
    const s = series[f.statement];
    const row = (s.rows[f.lineItem] ||= new Array(s.periods.length).fill(null));
    row[s.periods.indexOf(f.periodEnd)] = r2(f.value);
  }
  const growth = {};
  for (const f of d.facts) if (f.statement === 'growth') growth[f.lineItem] = r2(f.value);

  const at = (st, label, period) => {
    const s = series[st];
    if (!s || !s.rows[label]) return null;
    const i = period ? s.periods.indexOf(period) : s.periods.length - 1;
    return i < 0 ? null : s.rows[label][i];
  };
  const lastOf = (st, label) => {
    const s = series[st];
    if (!s || !s.rows[label]) return null;
    const arr = s.rows[label];
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && s.periods[i] !== 'TTM') return arr[i];
    return null;
  };

  const price = money(t['Current Price']);
  const mcap = money(t['Market Cap']);
  const bv = money(t['Book Value']);
  const pe = money(t['Stock P/E']);
  const dy = money(t['Dividend Yield']);
  const isBank = !!(series.quarters?.rows['Financing Profit'] || series.quarters?.rows['Revenue']);

  const salesTTM = at('pnl', isBank ? 'Revenue' : 'Sales', 'TTM') ?? lastOf('pnl', isBank ? 'Revenue' : 'Sales');
  const ebitdaTTM = at('pnl', isBank ? 'Financing Profit' : 'Operating Profit', 'TTM')
    ?? lastOf('pnl', isBank ? 'Financing Profit' : 'Operating Profit');
  const shares = price && mcap ? mcap / price : null;
  const borrow = lastOf('balance_sheet', 'Borrowings') ?? lastOf('balance_sheet', 'Borrowing');
  const invest = lastOf('balance_sheet', 'Investments');
  const fcf = lastOf('cash_flow', 'Free Cash Flow');
  const ocf = lastOf('cash_flow', 'Cash from Operating Activity');
  const exp = expectedResults(d.latestQuarter);

  const metrics = {
    price, mcap, bv, pe, dy,
    roce: money(t['ROCE']), roe: money(t['ROE']), fv: money(t['Face Value']),
    hl: t['High / Low'] || null,
    pb: r2(price && bv ? price / bv : null),
    ps: r2(price && shares && salesTTM ? price / (salesTTM / shares) : null),
    pfcf: r2(price && shares && fcf > 0 ? price / (fcf / shares) : null),
    pocf: r2(price && shares && ocf > 0 ? price / (ocf / shares) : null),
    ey: r2(pe ? 100 / pe : null),
    fcfy: r2(mcap && fcf ? (fcf / mcap) * 100 : null),
    // EV multiples are not meaningful for lenders - deliberately null, not zero
    evEbitda: r2(!isBank && mcap && ebitdaTTM > 0 ? (mcap + (borrow || 0)) / ebitdaTTM : null),
    evEbitdaNet: r2(!isBank && mcap && ebitdaTTM > 0 ? (mcap + (borrow || 0) - (invest || 0)) / ebitdaTTM : null),
    evSales: r2(!isBank && mcap && salesTTM > 0 ? (mcap + (borrow || 0)) / salesTTM : null),
    shares: r2(shares),
  };

  const common = {
    symbol: sym,
    name: nameOf[sym] || d.company,
    sector: sectorOf[sym] || 'Unknown',
    variant: d.variant,
    isBank,
    latestQuarter: d.latestQuarter,
    nextQuarterEnd: exp?.quarterEnd ?? null,
    resultsDueBy: exp?.dueBy ?? null,
    resultsDate: calendar[sym]?.date ?? null,
    ...metrics,
  };

  list.push(common);
  writeFileSync(`${OUT}/companies/${sym}.json`, JSON.stringify({ ...common, growth, series }));
}

list.sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0));

const sectors = {};
for (const c of list) (sectors[c.sector] ||= []).push(c.symbol);

writeFileSync(`${OUT}/index.json`, JSON.stringify({
  meta: {
    snapshot: '2026-08-27',
    source: 'screener.in',
    latestQuarter: '2026-06',
    companies: list.length,
    sectors: Object.keys(sectors).length,
    calendarEntries: Object.keys(calendar).length,
  },
  sectors,
  companies: list,
}));

const size = p => (Buffer.byteLength(readFileSync(p)) / 1024).toFixed(0) + ' KB';
console.log(`companies ${list.length} | sectors ${Object.keys(sectors).length}`);
console.log(`index.json ${size(`${OUT}/index.json`)}  (first paint)`);
console.log(`companies/ ${readdirSync(`${OUT}/companies`).length} files, ${(readdirSync(`${OUT}/companies`).reduce((a, f) => a + Buffer.byteLength(readFileSync(`${OUT}/companies/${f}`)), 0) / 1048576).toFixed(2)} MB total (lazy)`);
if (!Object.keys(calendar).length) console.log('note: no results_calendar.json yet - dates fall back to SEBI deadlines');
