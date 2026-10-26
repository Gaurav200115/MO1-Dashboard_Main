"""NSE archive files: download, and convert each format into table rows.

Formats changed on 2024-07-08 (UDiFF); older days come from the legacy archive. Both are
converted to the same columns. NSE refuses HEAD requests, so everything is a GET.
"""
import datetime as dt
import io
import math
import re
import time
import zipfile

import pandas as pd
import requests

UDIFF_START = dt.date(2024, 7, 8)
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/130.0 Safari/537.36",
    "Accept": "*/*",
    "Referer": "https://www.nseindia.com/",
}
B = "https://nsearchives.nseindia.com"
NIFTY200_URLS = ["https://niftyindices.com/IndexConstituent/ind_nifty200list.csv",
                 f"{B}/content/indices/ind_nifty200list.csv"]
EQ_SERIES = ("EQ", "BE", "BZ")
UDIFF_TYPE = {"IDF": "FUTIDX", "STF": "FUTSTK", "IDO": "OPTIDX", "STO": "OPTSTK"}


def session():
    s = requests.Session()
    s.headers.update(HEADERS)
    return s


def get(s, url, want_zip=True, retries=3):
    """(bytes, seconds) or (None, seconds) on 404. Raises after repeated other failures."""
    for attempt in range(1, retries + 1):
        t0 = time.monotonic()
        try:
            r = s.get(url, timeout=60)
        except requests.RequestException:
            if attempt == retries:
                raise
            time.sleep(3 * attempt)
            continue
        took = time.monotonic() - t0
        if r.status_code == 404:
            return None, took
        if r.status_code == 200 and (not want_zip or r.content[:2] == b"PK"):
            return r.content, took
        if attempt == retries:
            raise RuntimeError(f"HTTP {r.status_code} from {url}")
        time.sleep(3 * attempt)


def paise(x):
    """Rupees -> whole paise; None for blanks."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    try:
        return int(round(float(x) * 100))
    except (TypeError, ValueError):
        return None


def num(x, kind=int):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    try:
        return kind(float(x))
    except (TypeError, ValueError):
        return None


def _zip_csv(content, member=None, **kw):
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        name = member(z.namelist()) if member else z.namelist()[0]
        df = pd.read_csv(z.open(name), low_memory=False, **kw)
    df.columns = [c.strip() for c in df.columns]
    return df.loc[:, ~df.columns.str.startswith("Unnamed")]


def _mon(d):
    return d.strftime("%b").upper()


# ---------------- F&O bhavcopy ----------------

def fo_url(d):
    if d >= UDIFF_START:
        return f"{B}/content/fo/BhavCopy_NSE_FO_0_0_0_{d:%Y%m%d}_F_0000.csv.zip"
    return f"{B}/content/historical/DERIVATIVES/{d:%Y}/{_mon(d)}/fo{d:%d}{_mon(d)}{d:%Y}bhav.csv.zip"


FO_COLUMNS = ["trade_date", "instrument", "symbol", "expiry_date", "strike_paise", "option_type", "open_paise",
              "high_paise", "low_paise", "close_paise", "settle_paise", "contracts", "turnover_rs", "open_interest",
              "change_in_oi", "underlying_paise", "lot_size", "security_id"]


def fo_rows(content, d):
    b = _zip_csv(content)
    rows = []
    if d >= UDIFF_START:
        b = b[b.FinInstrmTp.isin(UDIFF_TYPE)]
        for r in b.itertuples(index=False):
            inst = UDIFF_TYPE[r.FinInstrmTp]
            fut = inst.startswith("FUT")
            rows.append((d, inst, r.TckrSymb, dt.date.fromisoformat(str(r.XpryDt)[:10]),
                         0 if fut else paise(r.StrkPric), "" if fut else str(r.OptnTp),
                         paise(r.OpnPric), paise(r.HghPric), paise(r.LwPric), paise(r.ClsPric), paise(r.SttlmPric),
                         num(r.TtlTradgVol), num(r.TtlTrfVal, float), num(r.OpnIntrst), num(r.ChngInOpnIntrst),
                         paise(r.UndrlygPric),
                         num(r.NewBrdLotQty), num(r.FinInstrmId)))
    else:
        b["INSTRUMENT"] = b.INSTRUMENT.astype(str).str.strip()
        b = b[b.INSTRUMENT.isin(UDIFF_TYPE.values())]
        for r in b.itertuples(index=False):
            fut = r.INSTRUMENT.startswith("FUT")
            rows.append((d, r.INSTRUMENT, str(r.SYMBOL).strip(),
                         dt.datetime.strptime(str(r.EXPIRY_DT).strip(), "%d-%b-%Y").date(),
                         0 if fut else paise(r.STRIKE_PR), "" if fut else str(r.OPTION_TYP).strip(),
                         paise(r.OPEN), paise(r.HIGH), paise(r.LOW), paise(r.CLOSE), paise(r.SETTLE_PR),
                         num(r.CONTRACTS), None if num(r.VAL_INLAKH, float) is None else num(r.VAL_INLAKH, float) * 1e5,
                         num(r.OPEN_INT), num(r.CHG_IN_OI), None, None, None))
    return rows


# ---------------- CM bhavcopy ----------------

def cm_url(d):
    if d >= UDIFF_START:
        return f"{B}/content/cm/BhavCopy_NSE_CM_0_0_0_{d:%Y%m%d}_F_0000.csv.zip"
    return f"{B}/content/historical/EQUITIES/{d:%Y}/{_mon(d)}/cm{d:%d}{_mon(d)}{d:%Y}bhav.csv.zip"


CM_COLUMNS = ["trade_date", "symbol", "series", "isin", "open_paise", "high_paise", "low_paise", "close_paise",
              "last_paise", "prev_close_paise", "volume", "turnover", "trades"]


def cm_rows(content, d):
    b = _zip_csv(content)
    rows = []
    if d >= UDIFF_START:
        b = b[b.SctySrs.isin(EQ_SERIES)]
        for r in b.itertuples(index=False):
            rows.append((d, r.TckrSymb, r.SctySrs, r.ISIN, paise(r.OpnPric), paise(r.HghPric), paise(r.LwPric),
                         paise(r.ClsPric), paise(r.LastPric), paise(r.PrvsClsgPric), num(r.TtlTradgVol),
                         num(r.TtlTrfVal, float), num(r.TtlNbOfTxsExctd)))
    else:
        b["SERIES"] = b.SERIES.astype(str).str.strip()
        b = b[b.SERIES.isin(EQ_SERIES)]
        for r in b.itertuples(index=False):
            rows.append((d, str(r.SYMBOL).strip(), r.SERIES, str(r.ISIN).strip(), paise(r.OPEN), paise(r.HIGH),
                         paise(r.LOW), paise(r.CLOSE), paise(r.LAST), paise(r.PREVCLOSE), num(r.TOTTRDQTY),
                         num(r.TOTTRDVAL, float), num(r.TOTALTRADES)))
    return rows


# ---------------- corporate actions (PR package, bc file) ----------------

def pr_url(d):
    return f"{B}/archives/equities/bhavcopy/pr/PR{d:%d%m%y}.zip"


_N = r"(\d+(?:\.\d+)?)"
_RS = r"(?:RS|RE|INR)?\.?\s*"
SPLIT_RE = re.compile(rf"(?:SPLT|SPLIT|SUB[- ]?DIVISION)\b.*?(?:FRM|FROM)\s*{_RS}{_N}.*?\bTO\s*{_RS}{_N}")
CONSOL_RE = re.compile(rf"CONSOL\w*.*?(?:FRM|FROM)\s*{_RS}{_N}.*?\bTO\s*{_RS}{_N}")
BONUS_RE = re.compile(r"BONUS\s*(\d+)\s*:\s*(\d+)")
RIGHTS_RE = re.compile(r"RI?GHTS?\s*(\d+)\s*:\s*(\d+)")      # NSE also writes "RGHTS 3:20"
DIV_RE = re.compile(rf"DIV\w*\s*[-:]?\s*(?:RS|RE|INR)\.?\s*{_N}")
MEETING_RE = re.compile(r"\b(?:AGM|EGM|EOGM|ANNUAL GENERAL MEETING|POSTAL BALLOT)\b")


def parse_purpose(text):
    """NSE's purpose text -> (action_type, ratio_from, ratio_to, dividend_amount)."""
    p = re.sub(r"\s+", " ", str(text).upper()).strip()
    divs = [float(x) for x in DIV_RE.findall(p)]
    div = sum(divs) if divs else None
    for rx, kind in ((SPLIT_RE, "SPLIT"), (CONSOL_RE, "FV_CHANGE")):
        if m := rx.search(p):
            return kind, float(m.group(1)), float(m.group(2)), div
    for rx, kind in ((BONUS_RE, "BONUS"), (RIGHTS_RE, "RIGHTS")):
        if m := rx.search(p):
            return kind, int(m.group(1)), int(m.group(2)), div
    if "DEMERGER" in p:
        return "DEMERGER", None, None, div
    if "MERGER" in p or "AMALGAMATION" in p:
        return "MERGER", None, None, div
    if "DIV" in p:
        return "DIVIDEND", None, None, div
    if MEETING_RE.search(p):
        return "MEETING", None, None, None
    return "OTHER", None, None, None


def _date(s):
    s = str(s).strip()
    if not s or s.lower() == "nan":
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%b-%Y", "%d-%m-%Y"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def corporate_action_rows(content, d):
    """(symbol, ex_date, purpose_key, series, company, record_date, purpose_raw, action_type,
        ratio_from, ratio_to, dividend_amount, first_seen) for equity series with an ex-date."""
    def bc(names):   # bcDDMMYYYY.csv now, BcDDMMYY.csv in older packages
        return next(n for n in names if n.lower().startswith("bc") and n.lower().endswith(".csv"))
    b = _zip_csv(content, member=bc, dtype=str, encoding="latin-1", keep_default_na=False)
    b = b.apply(lambda c: c.str.strip())
    b = b[b.SERIES.isin(EQ_SERIES)]
    rows = []
    for r in b.itertuples(index=False):
        ex = _date(r.EX_DT)
        if ex is None:
            continue
        kind, rf, rt, div = parse_purpose(r.PURPOSE)
        rows.append((r.SYMBOL, ex, re.sub(r"\s+", " ", r.PURPOSE.upper()), r.SERIES, r.SECURITY,
                     _date(r.RECORD_DT), r.PURPOSE, kind, rf, rt, div, d))
    return rows


# ---------------- F&O ban list ----------------

def ban_url(d):
    return f"{B}/archives/fo/sec_ban/fo_secban_{d:%d%m%Y}.csv"


def ban_symbols(content):
    """'Securities in Ban For Trade Date 16-OCT-2026:' then '1,SYMBOL' lines (or none)."""
    out = []
    for line in content.decode("latin-1").splitlines()[1:]:
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2 and parts[0].isdigit() and parts[1]:
            out.append(parts[1])
    return out


# ---------------- NIFTY 200 constituents ----------------

def nifty200(s):
    for url in NIFTY200_URLS:
        try:
            r = s.get(url, timeout=60)
        except requests.RequestException:
            continue
        if r.status_code == 200 and r.content.lstrip()[:12].lower().startswith(b"company name"):
            df = pd.read_csv(io.BytesIO(r.content))
            df.columns = [c.strip() for c in df.columns]
            return df.rename(columns={"Company Name": "company_name", "Industry": "industry", "Symbol": "symbol",
                                      "Series": "series", "ISIN Code": "isin"})
    raise RuntimeError("could not download the NIFTY 200 constituents file from NSE")
