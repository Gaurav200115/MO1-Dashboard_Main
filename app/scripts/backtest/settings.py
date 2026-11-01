"""Settings for the backtest engine.

The strategy rules are NOT here - they are mirrored from registry.ts in
backtest/strategies.py and checked against it before every run. What lives here
is what the replay needs and the live desk does not have: the liquidity floors
that stand in for a spread the archive never stored.

Changing any of these changes a run's fingerprint, so a run made under different
floors is a different run rather than a quiet rewrite of an old one.
"""

# ---------------- the approximated book gate (section 6.8) ----------------
#
# The live gate runs six checks. Two reproduce exactly here - the contract
# traded today (option_1min.volume) and the strike carries at least 3% of its
# chain's heaviest open interest (fo_bhavcopy.open_interest). Those are not
# approximations and are not configured here; they come from the strategy's own
# params, exactly as live.
#
# The other four are all spread tests, and a spread is the one thing the archive
# does not hold. They are stood in for by liquidity, on the reasoning the live
# gate was built on: the books that failed it were thin ones.
#
#     clear     comfortably above the floors - the live gate would almost
#               certainly have let it through
#     approx    passes, but near the floors - the live gate might have refused
#               it. Taken, counted, and marked.
#     rejected  below the floors - not traded, as the live desk would not have
#
# PROVISIONAL until step 0 of the build order calibrates them against the 155
# trades the live desk actually took. Those trades all passed the real gate, so
# a floor that rejects a large share of them is too strict. Until that run has
# happened these numbers are a starting point and nothing more - any result
# produced with them should be read as such.
GATE_CALIBRATED = False

GATE_FLOORS = {
    # Lots traded at that strike in the entry minute. The strongest proxy: a
    # contract nobody is trading in the minute we claim to have bought it is the
    # SHREECEM case, which is what the live gate was built to stop.
    "entry_minute_lots_clear": 10,
    "entry_minute_lots_min": 1,

    # Contracts traded at that strike over the whole day (fo_bhavcopy.contracts).
    "day_contracts_clear": 500,
    "day_contracts_min": 50,

    # The stock's own monthly liquidity (liquidity_rank).
    "turnover_median_clear": 50_000_000,      # rupees a day
    "turnover_median_min": 10_000_000,
    "atm_oi_lots_clear": 2_000,
    "atm_oi_lots_min": 500,                   # the downloader's own floor
}

# ---------------- the run ----------------

# A session needs all 14 option series (7 strikes x CE/PE) marked done to count
# as fully covered. Partial days are still replayed, and counted separately.
REQUIRE_FULL_COVERAGE = False

# How often the worker looks for a queued run, in seconds.
POLL_SECONDS = 20

# Sessions between progress writes. A run of three months is ~60 sessions, so
# every session is cheap and makes the progress bar move honestly.
PROGRESS_EVERY = 1

# Safety rail: refuse a range longer than this many calendar days in one run.
MAX_RANGE_DAYS = 400
