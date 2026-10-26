"""Settings, secrets and folders. Secrets are read from .env and are never printed.

Two folders:
  code  - this package and settings.py, in the MO1 repo (app/scripts/marketdata); deployed by git
  data  - MARKETDATA_DATA_DIR (on the VPS /opt/marketdata): .env, the Dhan token, logs, progress.
          Never in git. Defaults to the code folder for a local run.

.env keys: DATABASE_URL, DHAN_CLIENT_ID, DHAN_PIN, DHAN_TOTP_SECRET
           (DHAN_ACCESS_TOKEN instead of PIN + TOTP works too, but expires after ~24 h).
           MARKETDATA_PROFILE=year (or test) in .env picks the profile without a code change.
Extra env files can be listed in MARKETDATA_ENV_FILES (separated like PATH).
MARKETDATA_PROFILE / MARKETDATA_DATASETS / MARKETDATA_END_DATE / MARKETDATA_TRADING_DAYS /
MARKETDATA_RUN_WINDOW override settings.py; the shell wins over .env.
"""
import datetime as dt
import importlib.util
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]                      # the code folder
DATA_DIR = Path(os.environ.get("MARKETDATA_DATA_DIR") or ROOT)  # .env, token, logs, progress
STATE = DATA_DIR / "state"
LOGS = DATA_DIR / "logs"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))

_KEYS = ("DATABASE_URL", "DHAN_CLIENT_ID", "CLIENT_ID", "DHAN_PIN", "DHAN_TOTP_SECRET", "DHAN_ACCESS_TOKEN",
         "MARKETDATA_PROFILE", "MARKETDATA_DATASETS", "MARKETDATA_END_DATE", "MARKETDATA_TRADING_DAYS",
         "MARKETDATA_RUN_WINDOW")


def _parse_env(path):
    env = {}
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$", line)
        if m:
            v = m.group(2)
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
                v = v[1:-1]
            env[m.group(1)] = v
    return env


def _load_env():
    env = {}
    files = [DATA_DIR / ".env"] + [Path(p) for p in os.environ.get("MARKETDATA_ENV_FILES", "").split(os.pathsep) if p]
    for f in files:
        if f.exists():
            env.update(_parse_env(f))
    for k in _KEYS:                      # systemd's EnvironmentFile / the shell wins
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


ENV = _load_env()


def need(key):
    value = ENV.get(key)
    if not value:
        raise SystemExit(f"{key} is not set - add it to {DATA_DIR / '.env'}")
    return value


def client_id():
    return ENV.get("DHAN_CLIENT_ID") or ENV.get("CLIENT_ID") or need("DHAN_CLIENT_ID")


def _load_settings():
    spec = importlib.util.spec_from_file_location("settings", ROOT / "settings.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if ENV.get("MARKETDATA_PROFILE"):
        mod.PROFILE = ENV["MARKETDATA_PROFILE"]
    if ENV.get("MARKETDATA_DATASETS"):
        mod.DATASETS = [x.strip() for x in ENV["MARKETDATA_DATASETS"].split(",") if x.strip()]
    if ENV.get("MARKETDATA_END_DATE"):
        mod.END_DATE = ENV["MARKETDATA_END_DATE"]
    if ENV.get("MARKETDATA_RUN_WINDOW"):             # e.g. "16:00-06:00"
        mod.RUN_WINDOW = tuple(ENV["MARKETDATA_RUN_WINDOW"].split("-"))
    if ENV.get("MARKETDATA_TRADING_DAYS"):          # a quick trial with fewer days
        mod.PROFILES[mod.PROFILE] = {**mod.PROFILES[mod.PROFILE], "trading_days": int(ENV["MARKETDATA_TRADING_DAYS"])}
    if mod.PROFILE not in mod.PROFILES:
        raise SystemExit(f"settings.py: PROFILE {mod.PROFILE!r} is not one of {list(mod.PROFILES)}")
    return mod


S = _load_settings()
PROFILE = S.PROFILES[S.PROFILE]


PROGRESS_DIR = DATA_DIR / "progress"         # readable by the MO1 dashboard (no secrets in it)

# MARKETDATA_IGNORE_WINDOW=1 runs outside RUN_WINDOW - for a manual test run.
IGNORE_WINDOW = os.environ.get("MARKETDATA_IGNORE_WINDOW") == "1"


def today_ist():
    return dt.datetime.now(IST).date()


def _hm(text):
    h, m = map(int, text.split(":"))
    return dt.time(h, m)


def window_bounds(now=None):
    """(start, end) of the run window that contains `now`, or of the next one. Handles a window
    that crosses midnight (16:00 -> 06:00)."""
    now = now or dt.datetime.now(IST)
    start_t, end_t = _hm(S.RUN_WINDOW[0]), _hm(S.RUN_WINDOW[1])
    for day in (now.date() - dt.timedelta(days=1), now.date(), now.date() + dt.timedelta(days=1)):
        start = dt.datetime.combine(day, start_t, tzinfo=IST)
        end = dt.datetime.combine(day + dt.timedelta(days=1 if end_t <= start_t else 0), end_t, tzinfo=IST)
        if now < end:
            return start, end
    raise AssertionError("unreachable")


def in_window(now=None):
    now = now or dt.datetime.now(IST)
    start, _ = window_bounds(now)
    return now >= start


def window_hours():
    start, end = window_bounds(dt.datetime(2026, 1, 1, 12, tzinfo=IST))
    return (end - start).total_seconds() / 3600


def end_date():
    return dt.date.fromisoformat(S.END_DATE) if S.END_DATE else today_ist() - dt.timedelta(days=1)
