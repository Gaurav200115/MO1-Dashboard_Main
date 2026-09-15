/**
 * Parse archived screener.in pages into long-format fact records.
 *
 *   node scripts/parse.mjs            # parse every symbol's newest snapshot
 *   node scripts/parse.mjs ITC HDFCBANK
 *
 * Reads  data/raw/{SYMBOL}/{DATE}.html.gz
 * Writes data/facts/{SYMBOL}.json
 *
 * Long format is deliberate: banks and manufacturers expose different line
 * items ("Sales" vs "Revenue", "Operating Profit" vs "Financing Profit",
 * plus Deposits / Gross NPA %), so a wide schema would silently null out the
 * ~48 financials in the index.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const RAW = 'data/raw', FACTS = 'data/facts', STATE = 'data/state';
const REQUIRED = ['quarters', 'profit-loss', 'balance-sheet', 'cash-flow', 'shareholding'];
const MONTHS = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
                 Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };

const strip = h => h.replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

/** "Jun 2026" -> "2026-06"; "TTM" passes through; anything else -> null. */
function period(label) {
  const m = /^([A-Z][a-z]{2})\s+(\d{4})$/.exec(label.trim());
  if (m && MONTHS[m[1]]) return `${m[2]}-${MONTHS[m[1]]}`;
  return /^TTM$/i.test(label.trim()) ? 'TTM' : null;
}

/** Indian-format numerics: "3,36,304" -> 336304, "39%" -> 39, "-" -> null. */
function num(raw) {
  if (raw == null) return null;
  const t = String(raw).replace(/[₹,\s]/g, '').replace(/Cr\.?$/i, '');
  if (t === '' || t === '-' || t === '--') return null;
  const v = parseFloat(t.replace('%', ''));
  return Number.isFinite(v) ? v : null;
}

function unitOf(rawCell, lineItem) {
  if (/%/.test(rawCell)) return 'pct';
  if (/EPS|per share|Book Value|Price|High|Low|Face Value/i.test(lineItem)) return 'rs';
  if (/Days|Cycle/i.test(lineItem)) return 'days';
  if (/Shareholders/i.test(lineItem)) return 'count';
  return 'cr';
}

function section(html, id) {
  const marker = html.indexOf('id="' + id + '"');
  if (marker < 0) return '';
  const open = html.lastIndexOf('<section', marker);
  if (open < 0) return '';
  let end = html.indexOf('<section', marker);
  if (end < 0) end = html.indexOf('<footer', marker);
  if (end < 0) end = html.length;
  return html.slice(open, end);
}

function tables(blob) {
  return [...blob.matchAll(/<table[\s\S]*?<\/table>/g)].map(t =>
    [...t[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
      .map(r => [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(c => strip(c[1])))
      .filter(cells => cells.some(Boolean))
  ).filter(rows => rows.length);
}

/** A period-column table -> one fact per (lineItem, period). */
function factsFromTable(rows, statement, out, warn) {
  const header = rows[0];
  const cols = header.map(period);
  if (!cols.some(Boolean)) return false;
  for (const row of rows.slice(1)) {
    const label = row[0].replace(/\s*\+$/, '').trim();
    if (!label || /^Raw PDF$/i.test(label)) continue;
    for (let i = 1; i < row.length; i++) {
      if (!cols[i]) continue;
      const value = num(row[i]);
      if (value === null) continue;
      out.push({ statement, lineItem: label, periodEnd: cols[i],
                 value, unit: unitOf(row[i], label) });
    }
  }
  return true;
}

function parseOne(symbol, variantMap) {
  const dir = `${RAW}/${symbol}`;
  if (!existsSync(dir)) return { symbol, error: 'no_snapshot' };
  const snap = readdirSync(dir).filter(f => f.endsWith('.html.gz')).sort().pop();
  if (!snap) return { symbol, error: 'no_snapshot' };
  const html = gunzipSync(readFileSync(`${dir}/${snap}`)).toString('utf8');

  const missing = REQUIRED.filter(id => !section(html, id));
  if (missing.length) return { symbol, error: 'missing_sections:' + missing.join(',') };

  const facts = [];
  const warn = [];

  // period-column statements
  for (const [id, statement] of [['quarters','quarters'], ['profit-loss','pnl'],
                                 ['balance-sheet','balance_sheet'], ['cash-flow','cash_flow'],
                                 ['ratios','ratios'], ['shareholding','shareholding']]) {
    const tabs = tables(section(html, id));
    let matched = 0;
    for (const rows of tabs) if (factsFromTable(rows, statement, facts, warn)) matched++;
    if (!matched && id !== 'ratios') warn.push(`no_period_table:${id}`);
  }

  // growth boxes inside profit-loss ("Compounded Sales Growth" / "10 Years: | 7%")
  for (const rows of tables(section(html, 'profit-loss'))) {
    const title = rows[0]?.[0] || '';
    if (!/Compounded|CAGR|Return on Equity/i.test(title) || rows[0].length > 2) continue;
    for (const r of rows.slice(1)) {
      const v = num(r[1]);
      if (v !== null) facts.push({ statement: 'growth',
        lineItem: `${title} / ${r[0].replace(/:$/, '')}`, periodEnd: null, value: v, unit: 'pct' });
    }
  }

  // headline ratio strip
  const top = {};
  const ul = /<ul id="top-ratios">([\s\S]*?)<\/ul>/.exec(html);
  if (ul) for (const li of ul[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
    const n = /class="name">([\s\S]*?)<\/span>/.exec(li[1]);
    if (!n) continue;
    // "High / Low" carries two value spans - keep the whole remainder
    const rest = strip(li[1].replace(/<span class="name">[\s\S]*?<\/span>/, ''));
    if (rest) top[strip(n[1])] = rest;
  }

  const nameM = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  const sectors = [...html.matchAll(/<a[^>]*href="\/market\/[^"]*"[^>]*title="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    .reduce((a, m) => (a[m[1]] = strip(m[2]), a), {});

  const periods = [...new Set(facts.filter(f => f.statement === 'quarters' && f.periodEnd !== 'TTM')
    .map(f => f.periodEnd))].sort();

  return {
    symbol,
    source: 'screener.in',
    variant: variantMap[symbol] || 'unknown',
    snapshot: snap.replace('.html.gz', ''),
    company: nameM ? strip(nameM[1]) : null,
    classification: sectors,
    topRatios: top,
    latestQuarter: periods[periods.length - 1] || null,
    factCount: facts.length,
    warnings: warn,
    facts,
  };
}

// ---- main ----
mkdirSync(FACTS, { recursive: true });

const variantMap = {};
const runDir = `${STATE}/runs`;
if (existsSync(runDir)) for (const f of readdirSync(runDir)) {
  for (const line of readFileSync(`${runDir}/${f}`, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.variant) variantMap[r.symbol] = r.variant; } catch {}
  }
}

const argv = process.argv.slice(2);
const symbols = argv.length ? argv
  : (existsSync(RAW) ? readdirSync(RAW).sort() : []);

let ok = 0, failed = [], warned = [];
for (const s of symbols) {
  const r = parseOne(s, variantMap);
  if (r.error) { failed.push(`${s}:${r.error}`); continue; }
  writeFileSync(`${FACTS}/${s}.json`, JSON.stringify(r, null, 1) + '\n');
  ok++;
  if (r.warnings.length) warned.push(`${s}:${r.warnings.join('|')}`);
}

console.log(`parsed ${ok}/${symbols.length} symbols`);
if (warned.length) console.log(`warnings (${warned.length}): ${warned.slice(0, 10).join('  ')}`);
if (failed.length) console.log(`failed (${failed.length}): ${failed.slice(0, 20).join('  ')}`);
