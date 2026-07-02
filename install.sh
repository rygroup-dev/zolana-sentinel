#!/usr/bin/env bash
# Zolana Sentinel — one-line interactive installer (full dependencies).
#
#   curl -fsSL https://raw.githubusercontent.com/rygroup-dev/zolana-sentinel/main/install.sh | bash
#
# Installs Node.js (if missing), clones the repo, installs all npm dependencies,
# then interactively asks for your wallet private key, Telegram bot token and
# Telegram chat id and writes them to .env. Idempotent — safe to re-run.
set -euo pipefail

REPO="https://github.com/rygroup-dev/zolana-sentinel.git"
DIR="${ZOLANA_DIR:-$HOME/zolana-sentinel}"
NODE_MAJOR=20

# Read from the real terminal even when the script is piped through `curl | bash`.
TTY=/dev/tty
[ -e "$TTY" ] || TTY=""

c_cyan=$'\033[1;36m'; c_grn=$'\033[1;32m'; c_yel=$'\033[1;33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
log() { printf '%s[zolana]%s %s\n' "$c_cyan" "$c_off" "$*"; }

banner() {
  printf '%s' "$c_cyan"
  cat <<'ART'

  ┌────────────────────────────────────────────────┐
  │            ⚡  Z O L A N A   S E N T I N E L      │
  │        Autonomous bot for play.zolana.gg         │
  │                    by rygroup                    │
  └────────────────────────────────────────────────┘
ART
  printf '%s\n' "$c_off"
}

# ask VAR "Label" [secret]
ask() {
  local __var="$1" __label="$2" __secret="${3:-}" __val=""
  if [ -z "$TTY" ]; then
    log "No terminal available — edit $DIR/.env manually after install."; return 1
  fi
  while [ -z "$__val" ]; do
    if [ "$__secret" = "secret" ]; then
      printf '%s  %s:%s ' "$c_yel" "$__label" "$c_off" > "$TTY"
      IFS= read -r -s __val < "$TTY"; printf '\n' > "$TTY"
    else
      printf '%s  %s:%s ' "$c_yel" "$__label" "$c_off" > "$TTY"
      IFS= read -r __val < "$TTY"
    fi
  done
  printf -v "$__var" '%s' "$__val"
}

# set_env KEY VALUE — replace (or add) a single key in .env without sed escaping issues
set_env() {
  local key="$1" val="$2"
  grep -v "^${key}=" .env > .env.tmp 2>/dev/null || true
  mv .env.tmp .env
  printf '%s=%s\n' "$key" "$val" >> .env
}

banner

# 1. Node.js (>= 18)
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  log "Installing Node.js ${NODE_MAJOR}.x ..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo dnf install -y nodejs
  elif command -v brew >/dev/null 2>&1; then
    brew install "node@${NODE_MAJOR}"
  else
    log "Please install Node.js >= 18 manually, then re-run."; exit 1
  fi
fi
log "Node $(node -v), npm $(npm -v)"

# 2. Clone or update
if [ -d "$DIR/.git" ]; then
  log "Updating existing checkout in $DIR"
  git -C "$DIR" pull --ff-only || true
else
  log "Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

# 3. Dependencies (full install)
log "Installing npm dependencies ..."
npm install --no-audit --no-fund

# 4. Interactive config
if [ -f .env ] && grep -q '^ZOLANA_PRIVATE_KEY=.\+' .env; then
  log ".env already configured — keeping it."
else
  cp -n .env.example .env
  printf '\n%s  Enter your credentials (stored locally in %s/.env, never uploaded):%s\n\n' "$c_grn" "$DIR" "$c_off" > "${TTY:-/dev/stdout}"
  if ask PK  "Wallet private key (base58 or JSON array)" secret \
     && ask BT "Telegram bot token (from @BotFather)" \
     && ask CI "Telegram chat id (your numeric ID)"; then
    set_env ZOLANA_PRIVATE_KEY       "$PK"
    set_env ZOLANA_TELEGRAM_BOT_TOKEN "$BT"
    set_env ZOLANA_TELEGRAM_CHAT_ID   "$CI"
    set_env ZOLANA_REAL_RUN           "true"
    chmod 600 .env
    log "Saved to .env (permissions 600)."
  else
    chmod 600 .env
    log "Skipped — edit $DIR/.env manually before running."
  fi
fi

printf '%s' "$c_grn"
cat <<EOF

  ✅ Zolana Sentinel installed at $DIR

  Start it:
     cd $DIR && node src/index.js
     One cycle: node src/index.js --once
     Service (Linux): see README.md

  Then message your Telegram bot and send /status
EOF
printf '%s\n' "$c_off"
