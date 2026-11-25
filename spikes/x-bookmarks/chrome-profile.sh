#!/usr/bin/env bash
# A dedicated, normal Google Chrome profile for sites that reject logins from automated browsers.
#
#   chrome-profile.sh login  [id] [url]   plain Chrome, NO debug port, NO automation flags: log in by hand
#   chrome-profile.sh start  [id]         same profile with a localhost-only debug port, for scraping
#   chrome-profile.sh stop   [id]         quit that Chrome (the debug port closes with it)
#   chrome-profile.sh status [id]
#
# Why two modes: the login is the step sites police hardest, so it happens in a browser that carries
# no automation signal at all. The debug port is open only while `start` is running, because anything
# on this machine that can reach it can drive the browser, including reading its cookies.
#
# Extensions are disabled in both modes: a synced extension was found redirecting x.com/i/bookmarks to
# /i/history, and a scraping browser should not run code we did not choose.
#
# The profile lives under ~/.config/browser-login/profiles/<id>, which Claude Code's deny rules cover.
# Chrome refuses --remote-debugging-port on its default data directory, so a dedicated one is required.
set -euo pipefail

cmd="${1:-}"; id="${2:-x-prod-main}"
root="${CHROME_PROFILE_ROOT:-$HOME/.config/browser-login/profiles}"
dir="$root/$id"
port="${CHROME_DEBUG_PORT:-9333}"
chrome_app="${CHROME_APP:-Google Chrome}"

die() { echo "chrome-profile: $*" >&2; exit 1; }
running() { pgrep -f -- "--user-data-dir=$dir( |$)" >/dev/null 2>&1; }
port_up() { curl -fsS -m 2 "http://127.0.0.1:$port/json/version" >/dev/null 2>&1; }
default_url() { case "$id" in x-*) echo "https://x.com/i/flow/login" ;; xhs-*) echo "https://www.xiaohongshu.com/explore" ;; *) echo "about:blank" ;; esac; }

launch() { # launch <url> [extra chrome args...]
  local url="$1"; shift
  mkdir -p "$dir"; chmod 700 "$root" "$dir" 2>/dev/null || true
  open -n -a "$chrome_app" --args "--user-data-dir=$dir" --no-first-run --no-default-browser-check --disable-extensions "$@" "$url"
}

case "$cmd" in
  login)
    running && die "'$id' is already running; run: $0 stop $id"
    launch "${3:-$(default_url)}"
    cat <<EOF
A normal Chrome window opened with the dedicated profile '$id' (no debug port, no automation flags).
  1. Log in yourself, 2FA and captcha included.
  2. Quit THAT Chrome with Cmd+Q, so the login is flushed to disk. Your everyday Chrome is a separate
     instance and is not affected.
Then: $0 start $id
EOF
    ;;
  start)
    running && die "'$id' is already running; run: $0 stop $id"
    # The three --disable-* flags are the ones Puppeteer/Playwright pass by default: they keep Chrome from
    # throttling timers and rendering when the window is covered, which long scrolling relies on.
    launch "about:blank" "--remote-debugging-port=$port" "--remote-debugging-address=127.0.0.1" \
      --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling \
      ${CHROME_EXTRA_ARGS:-}
    for _ in $(seq 1 40); do port_up && break; sleep 0.5; done
    port_up || die "debug port $port did not come up"
    echo "READY port=$port profile=$dir"
    echo "scrape: node spikes/x-bookmarks/scrape.mjs --cdp $port"
    ;;
  stop)
    running || { echo "'$id' is not running"; exit 0; }
    pkill -TERM -f -- "--user-data-dir=$dir( |$)" || true
    for _ in $(seq 1 20); do running || break; sleep 0.5; done
    running && die "'$id' did not exit; quit it from its window"
    echo "stopped '$id'"
    ;;
  status)
    if running; then echo "'$id' running; debug port $(port_up && echo UP || echo down)"; else echo "'$id' not running"; fi
    [ -d "$dir" ] && echo "profile: $dir" || echo "profile: not created yet"
    ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
