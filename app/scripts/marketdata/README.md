# Market-data downloader

Downloads NIFTY 200 market data into PostgreSQL (TimescaleDB) on the VPS, every night from
**16:00 to 06:00 IST**, and reports progress to the desk's **Data → Data download** panel.

| Data | Source | Scope |
|---|---|---|
| Stock list + Dhan IDs | NSE NIFTY 200 file, Dhan instrument file | all 200 |
| F&O bhavcopy (end of day, every contract, incl. futures EOD) | NSE | every day |
| Cash-market bhavcopy (official daily OHLC) | NSE | every day |
| Corporate actions, F&O ban list | NSE | every day |
| Spot, 1-minute | Dhan | all 200 + NIFTY |
| Options, 1-minute, monthly expiry, ATM±3, calls + puts | Dhan | the 100 most liquid F&O stocks, re-chosen every month |

- **Code** lives here and is deployed with the dashboard. **Secrets and runtime files** live in
  `/opt/marketdata` on the VPS (`.env`, Dhan token, logs, `progress/progress.json`) - never in git.
- Settings: `settings.py`. Test or full year: `MARKETDATA_PROFILE` in `/opt/marketdata/.env`.
- Setup: `sudo bash deploy/install.sh` (once), after PostgreSQL is installed.
- Full build and deploy steps: `DATA/VPS-SETUP-GUIDE.pdf`.

Run by hand (any hour): `MARKETDATA_DATA_DIR=/opt/marketdata MARKETDATA_IGNORE_WINDOW=1 /opt/marketdata/venv/bin/python -m marketdata.backfill`
