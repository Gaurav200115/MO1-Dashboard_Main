#!/usr/bin/env bash
# One-time setup of the market-data downloader on the VPS. Safe to run again (e.g. after a deploy
# that changed requirements.txt or the files in deploy/).
#
#   cd <the MO1 repo on the VPS>
#   sudo bash app/scripts/marketdata/deploy/install.sh
#
# Run it with sudo FROM THE DASHBOARD'S USER (the one ~/deploy.sh runs as): the download runs as
# that user, so it can read the code in the repo and the dashboard can read its progress file.
# Override with RUN_USER=... or DATA_DIR=... in front of the command if needed.
#
# What it does: creates DATA_DIR (/opt/marketdata) with logs/ state/ progress/, a Python venv with
# the requirements, a .env from .env.example (if there is none), the systemd service + timer
# (16:00 IST daily) and the 15:40 IST token cron job. It does NOT install PostgreSQL - see the guide.
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${RUN_USER:-${SUDO_USER:-}}"
DATA_DIR="${DATA_DIR:-/opt/marketdata}"
PYTHON="${PYTHON:-python3}"

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash $0"; exit 1; fi
if [ -z "$RUN_USER" ] || [ "$RUN_USER" = "root" ]; then
  echo "Run it with sudo from the dashboard's user (not as root), or put RUN_USER=<user> in front."; exit 1
fi
id "$RUN_USER" >/dev/null 2>&1 || { echo "No such user: $RUN_USER"; exit 1; }
if ! sudo -u "$RUN_USER" test -r "$CODE_DIR/marketdata/backfill.py"; then
  echo "$RUN_USER cannot read $CODE_DIR - run this from that user's copy of the repo."; exit 1
fi

echo "code:  $CODE_DIR"
echo "data:  $DATA_DIR"
echo "user:  $RUN_USER"

# --- data folder ----------------------------------------------------------------------------
mkdir -p "$DATA_DIR/logs" "$DATA_DIR/state" "$DATA_DIR/progress"
chown -R "$RUN_USER": "$DATA_DIR"
chmod 755 "$DATA_DIR" "$DATA_DIR/progress" "$DATA_DIR/logs"
chmod 700 "$DATA_DIR/state"                       # holds the Dhan token

# --- python ---------------------------------------------------------------------------------
if [ ! -x "$DATA_DIR/venv/bin/python" ]; then
  sudo -u "$RUN_USER" "$PYTHON" -m venv "$DATA_DIR/venv"
fi
sudo -u "$RUN_USER" "$DATA_DIR/venv/bin/pip" install -q --upgrade pip
sudo -u "$RUN_USER" "$DATA_DIR/venv/bin/pip" install -q -r "$CODE_DIR/requirements.txt"
echo "python packages: installed"

# --- .env -----------------------------------------------------------------------------------
if [ ! -f "$DATA_DIR/.env" ]; then
  cp "$CODE_DIR/.env.example" "$DATA_DIR/.env"
  NEW_ENV=1
fi
chown "$RUN_USER": "$DATA_DIR/.env"
chmod 600 "$DATA_DIR/.env"

# --- systemd: service + timer ---------------------------------------------------------------
# 's/\r$//' strips Windows line endings, in case the files were saved on Windows
sed -e 's/\r$//' -e "s|@RUN_USER@|$RUN_USER|g" -e "s|@CODE_DIR@|$CODE_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" \
  "$CODE_DIR/deploy/marketdata-backfill.service.in" > /etc/systemd/system/marketdata-backfill.service
sed -e 's/\r$//' "$CODE_DIR/deploy/marketdata-backfill.timer" > /etc/systemd/system/marketdata-backfill.timer
command -v restorecon >/dev/null 2>&1 && restorecon -R "$DATA_DIR" /etc/systemd/system/marketdata-backfill.* || true
systemctl daemon-reload
systemctl enable marketdata-backfill.timer >/dev/null
systemctl start marketdata-backfill.timer
echo "systemd: timer enabled (16:00 IST daily)"

# --- cron: daily token at 15:40 IST (replaces our block, keeps the user's other lines) --------
BLOCK="$(sed -e 's/\r$//' -e "s|@CODE_DIR@|$CODE_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" "$CODE_DIR/deploy/crontab.in")"
{ crontab -u "$RUN_USER" -l 2>/dev/null | sed '/^# >>> marketdata/,/^# <<< marketdata/d'; echo "$BLOCK"; } \
  | crontab -u "$RUN_USER" -
systemctl enable --now crond >/dev/null 2>&1 || true
echo "cron: token refresh at 15:40 IST"

echo
systemctl list-timers marketdata-backfill.timer --no-pager || true
echo
if [ -n "${NEW_ENV:-}" ]; then
  echo "NEXT: fill in $DATA_DIR/.env (DATABASE_URL, DHAN_CLIENT_ID, DHAN_PIN, DHAN_TOTP_SECRET):"
  echo "      nano $DATA_DIR/.env"
else
  echo "$DATA_DIR/.env already exists - left unchanged."
fi
