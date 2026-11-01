#!/usr/bin/env bash
# One-time setup of the backtest worker on the VPS. Safe to run again (e.g. after a deploy that
# changed requirements.txt or the files in deploy/).
#
#   cd <the MO1 repo on the VPS>
#   sudo bash app/scripts/backtest/deploy/install.sh
#
# Run it with sudo FROM THE DASHBOARD'S USER (the one ~/deploy.sh runs as), the same user the
# market-data downloader runs as: the worker reads the code from the repo and the same PostgreSQL
# archive. Override with RUN_USER=... or DATA_DIR=... in front of the command if needed.
#
# What it does: creates DATA_DIR (/opt/backtest) with logs/, a Python venv with the requirements,
# a .env from .env.example (if there is none), and the systemd service. It does NOT install
# PostgreSQL and does not touch the downloader - see DATA/VPS-SETUP-GUIDE.md.
set -euo pipefail

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${RUN_USER:-${SUDO_USER:-}}"
DATA_DIR="${DATA_DIR:-/opt/backtest}"
PYTHON="${PYTHON:-python3}"

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash $0"; exit 1; fi
if [ -z "$RUN_USER" ] || [ "$RUN_USER" = "root" ]; then
  echo "Run it with sudo from the dashboard's user (not as root), or put RUN_USER=<user> in front."; exit 1
fi
id "$RUN_USER" >/dev/null 2>&1 || { echo "No such user: $RUN_USER"; exit 1; }
if ! sudo -u "$RUN_USER" test -r "$CODE_DIR/backtest/worker.py"; then
  echo "$RUN_USER cannot read $CODE_DIR - run this from that user's copy of the repo."; exit 1
fi

echo "code:  $CODE_DIR"
echo "data:  $DATA_DIR"
echo "user:  $RUN_USER"

# --- data folder ----------------------------------------------------------------------------
mkdir -p "$DATA_DIR/logs"
chown -R "$RUN_USER": "$DATA_DIR"
chmod 755 "$DATA_DIR" "$DATA_DIR/logs"

# --- python ---------------------------------------------------------------------------------
if [ ! -x "$DATA_DIR/venv/bin/python" ]; then
  sudo -u "$RUN_USER" "$PYTHON" -m venv "$DATA_DIR/venv"
fi
sudo -u "$RUN_USER" "$DATA_DIR/venv/bin/pip" install -q --upgrade pip
sudo -u "$RUN_USER" "$DATA_DIR/venv/bin/pip" install -q -r "$CODE_DIR/requirements.txt"
echo "python packages: installed"

# --- .env -----------------------------------------------------------------------------------
# The downloader already holds a working DATABASE_URL. Reuse it rather than asking for it twice -
# a second hand-typed copy is a second thing to get wrong and a second place a password lives.
if [ ! -f "$DATA_DIR/.env" ]; then
  cp "$CODE_DIR/.env.example" "$DATA_DIR/.env"
  if [ -f /opt/marketdata/.env ] && grep -q '^DATABASE_URL=' /opt/marketdata/.env; then
    DB_LINE="$(grep -m1 '^DATABASE_URL=' /opt/marketdata/.env)"
    sed -i "s|^DATABASE_URL=.*|$DB_LINE|" "$DATA_DIR/.env"
    echo ".env: DATABASE_URL copied from the downloader"
  fi
  NEW_ENV=1
fi
chown "$RUN_USER": "$DATA_DIR/.env"
chmod 600 "$DATA_DIR/.env"

# --- systemd --------------------------------------------------------------------------------
# 's/\r$//' strips Windows line endings, in case the files were saved on Windows
sed -e 's/\r$//' -e "s|@RUN_USER@|$RUN_USER|g" -e "s|@CODE_DIR@|$CODE_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" \
  "$CODE_DIR/deploy/backtest-worker.service.in" > /etc/systemd/system/backtest-worker.service
command -v restorecon >/dev/null 2>&1 && restorecon -R "$DATA_DIR" /etc/systemd/system/backtest-worker.service || true
systemctl daemon-reload
systemctl enable backtest-worker.service >/dev/null

if [ -n "${NEW_ENV:-}" ] && ! grep -q '^MONGO_CONNECTION_STRING=.\+' "$DATA_DIR/.env"; then
  echo "systemd: service enabled but NOT started - it needs MONGO_CONNECTION_STRING first"
else
  systemctl restart backtest-worker.service
  echo "systemd: worker started"
fi

echo
systemctl status backtest-worker.service --no-pager --lines=5 || true
echo
if [ -n "${NEW_ENV:-}" ]; then
  echo "NEXT: fill in $DATA_DIR/.env (MONGO_CONNECTION_STRING, and DATABASE_URL if it was not copied):"
  echo "      nano $DATA_DIR/.env"
  echo "      sudo systemctl restart backtest-worker"
else
  echo "$DATA_DIR/.env already exists - left unchanged."
fi
echo
echo "Check it over:   cd $CODE_DIR && $DATA_DIR/venv/bin/python run.py check"
echo "What's covered:  cd $CODE_DIR && $DATA_DIR/venv/bin/python run.py coverage"
echo "Worker log:      sudo journalctl -u backtest-worker -f"
