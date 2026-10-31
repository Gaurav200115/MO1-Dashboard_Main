"""NIFTY 200 constituents with Dhan IDs, F&O flag, lot size and strike step -> table `stocks`.
Also picks this run's stocks from settings.py."""
from .. import nse
from ..config import PROFILE, S, today_ist
from ..context import say


def _min_step(strikes):
    s = sorted(set(strikes))
    diffs = [b - a for a, b in zip(s, s[1:]) if b > a]
    return min(diffs) if diffs else None


def run(ctx):
    sm = ctx.instruments()
    c = nse.nifty200(nse.session())
    sm_nse = sm[sm.SEM_EXM_EXCH_ID == "NSE"]
    eq = sm_nse[(sm_nse.SEM_INSTRUMENT_NAME == "EQUITY") & (sm_nse.SEM_SERIES == "EQ")]
    eq_id = dict(zip(eq.SEM_TRADING_SYMBOL.astype(str), eq.SEM_SMST_SECURITY_ID.astype(int)))
    idx = sm_nse[sm_nse.SEM_INSTRUMENT_NAME == "INDEX"]
    index_id = dict(zip(idx.SEM_TRADING_SYMBOL.astype(str).str.upper(), idx.SEM_SMST_SECURITY_ID.astype(int)))

    opt = sm_nse[sm_nse.SEM_INSTRUMENT_NAME == "OPTSTK"].copy()
    opt["underlying"] = opt.SEM_TRADING_SYMBOL.astype(str).str.rsplit("-", n=3).str[0]   # BAJAJ-AUTO-Oct2026-9000-CE
    opt["expiry"] = opt.SEM_EXPIRY_DATE.astype(str).str[:10]
    near = opt[opt.expiry == opt.groupby("underlying").expiry.transform("min")]
    fno = near.groupby("underlying").agg(lot=("SEM_LOT_UNITS", "first"), step=("SEM_STRIKE_PRICE", _min_step))

    rows = []
    for r in c.itertuples(index=False):
        sym = r.symbol
        rows.append((sym, r.company_name, r.industry, r.isin, eq_id.get(sym), sym in fno.index,
                     int(fno.lot[sym]) if sym in fno.index else None,
                     float(fno.step[sym]) if sym in fno.index and fno.step[sym] else None, True, today_ist()))
    with ctx.conn.cursor() as cur:
        cur.execute("UPDATE stocks SET in_nifty200 = false")
        cur.executemany(
            "INSERT INTO stocks (symbol, company_name, industry, isin, security_id, has_fno, lot_size, strike_step, "
            "in_nifty200, as_of) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (symbol) DO UPDATE SET "
            "company_name = EXCLUDED.company_name, industry = EXCLUDED.industry, isin = EXCLUDED.isin, "
            "security_id = EXCLUDED.security_id, has_fno = EXCLUDED.has_fno, lot_size = EXCLUDED.lot_size, "
            "strike_step = EXCLUDED.strike_step, in_nifty200 = true, as_of = EXCLUDED.as_of", rows)
    ctx.conn.commit()

    want = PROFILE["stocks"]
    if want == "NIFTY200":
        ctx.universe = [r[0] for r in rows]
    else:
        missing = [s for s in want if s not in eq_id]
        if missing:
            raise SystemExit(f"settings.py stocks not found in Dhan's instrument file: {missing}")
        ctx.universe = list(want)
    ctx.fno = {s for s in ctx.universe if s in fno.index}
    ctx.security_id.update({s: eq_id[s] for s in ctx.universe if s in eq_id})
    for name in list(S.INDEX_SPOT) + ([S.VIX] if "vix_1min" in S.DATASETS else []):
        if name.upper() not in index_id:
            raise SystemExit(f"settings.py INDEX_SPOT: {name} is not an NSE index in Dhan's instrument file")
        ctx.security_id[name] = index_id[name.upper()]
    no_id = [s for s in ctx.universe if s not in ctx.security_id]
    say(f"stock list: {len(rows)} NIFTY 200 stocks, {int(fno.index.isin([r[0] for r in rows]).sum())} with F&O | "
        f"this run: {len(ctx.universe)} stocks ({len(ctx.fno)} with F&O)"
        + (f" | no Dhan ID: {no_id}" if no_id else ""))
