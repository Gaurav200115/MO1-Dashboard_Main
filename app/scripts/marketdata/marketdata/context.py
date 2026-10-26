"""What every job needs: the database connection, the trading days, the stocks, and the Dhan client."""
import datetime as dt
import os

import pandas as pd
import requests

from . import db
from .config import IST, STATE, S, today_ist
from .dhan import Dhan

INSTRUMENT_FILE_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"


def say(text=""):
    print(f"{dt.datetime.now(IST):%H:%M:%S}  {text}" if text else "", flush=True)


class Context:
    def __init__(self, conn, run_id):
        self.conn, self.run_id = conn, run_id
        self.sessions = []            # trading days of this run, oldest first
        self.universe = []            # stock symbols of this run
        self.fno = set()              # those with F&O
        self.security_id = {}         # symbol -> Dhan ID (stocks and indices)
        self.lines = []               # report lines
        self.deadline = None          # IST datetime when this run must stop (end of the run window)
        self.on_tick = None           # progress writer, set by backfill
        self._dhan = None
        self._instruments = None

    def time_up(self):
        return self.deadline is not None and dt.datetime.now(IST) >= self.deadline

    def tick(self):
        if self.on_tick:
            self.on_tick()

    @property
    def dhan(self):
        if self._dhan is None:
            self._dhan = Dhan(calls_already_today=db.calls_today(self.conn))
        return self._dhan

    def instruments(self):
        """Dhan's instrument file (scrip master), downloaded once a day; the last 3 kept."""
        if self._instruments is None:
            path = STATE / f"instrument_file_{today_ist()}.csv"
            if not path.exists():
                say("downloading Dhan instrument file (~27 MB)")
                r = requests.get(INSTRUMENT_FILE_URL, timeout=180)
                r.raise_for_status()
                STATE.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(".tmp")
                tmp.write_bytes(r.content)
                os.replace(tmp, path)
                for old in sorted(STATE.glob("instrument_file_*.csv"))[:-3]:
                    old.unlink()
            self._instruments = pd.read_csv(path, low_memory=False)
        return self._instruments

    def log(self, dataset, what, win, status, rows, seconds, workers=1, note=""):
        db.log_call(self.conn, self.run_id, dataset, what, win, status, rows, seconds, workers, note)

    @property
    def start(self):
        return self.sessions[0]

    @property
    def end(self):
        return self.sessions[-1]
