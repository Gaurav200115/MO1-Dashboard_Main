"""Settings, secrets and folders. Secrets are read from .env and are never printed.

Two folders, the same split the marketdata package uses:
  code  - this package and settings.py, in the MO1 repo (app/scripts/backtest); deployed by git
  data  - BACKTEST_DATA_DIR (on the VPS /opt/backtest): .env and logs. Never in git.
          Defaults to the code folder for a local run.

.env keys: DATABASE_URL          the market-data PostgreSQL, read-only is enough
           MONGO_CONNECTION_STRING, MONGO_DB    where results are written

Nothing in this file prints a value, and nothing anywhere should log ENV. A
connection string carries a live password.
"""
import datetime as dt
import importlib.util
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]                   # the code folder
INSTALLED = Path("/opt/backtest")


def _data_dir():
    """Where .env and logs live.

    BACKTEST_DATA_DIR wins, which is how the systemd unit points the worker at
    its folder. Failing that, the installed location if it is actually there -
    without this, running run.py by hand on the VPS looks in the code folder,
    finds no .env and reports DATABASE_URL as unset while it sits in
    /opt/backtest all along. The CLI is meant to be run by hand, so it has to
    find what install.sh created without being told. Last, the code folder, for
    a local checkout with no install.
    """
    named = os.environ.get("BACKTEST_DATA_DIR")
    if named:
        return Path(named)
    if (INSTALLED / ".env").exists():
        return INSTALLED
    return ROOT


DATA_DIR = _data_dir()
LOGS = DATA_DIR / "logs"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))

_KEYS = ("DATABASE_URL", "MONGO_CONNECTION_STRING", "MONGO_DB", "BACKTEST_POLL_SECONDS")


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
    files = [DATA_DIR / ".env", DATA_DIR / ".env.local"]
    files += [Path(p) for p in os.environ.get("BACKTEST_ENV_FILES", "").split(os.pathsep) if p]
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
        where = DATA_DIR / ".env"
        hint = "" if where.exists() else (
            f"\n  ({where} does not exist. If the data folder is somewhere else, "
            f"put BACKTEST_DATA_DIR=<that folder> in front of the command.)")
        raise SystemExit(f"{key} is not set - add it to {where}{hint}")
    return value


def mongo_db_name():
    return ENV.get("MONGO_DB") or "nifty200desk"


def _load_settings():
    spec = importlib.util.spec_from_file_location("backtest_settings", ROOT / "settings.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


S = _load_settings()


def ist_time(hhmm):
    h, m = map(int, hhmm.split(":"))
    return dt.time(h, m)
