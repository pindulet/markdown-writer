#!/bin/sh
# Får en ændring ud på både computeren og telefonen med én kommando
# (`npm run release`): tester, bygger begge udgaver, erstatter appen i
# /Applications og pusher til GitHub, som så udruller mobilversionen.
set -eu

cd "$(dirname "$0")/.."

APP_NAME="Markdown Writer"
BUNDLE_ID="dk.kristian.markdownwriter"
BUILT_APP="src-tauri/target/release/bundle/macos/$APP_NAME.app"
INSTALLED_APP="/Applications/$APP_NAME.app"

step() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nStop: %s\n' "$1" >&2; exit 1; }

app_running() {
  [ "$(osascript -e "application id \"$BUNDLE_ID\" is running" 2>/dev/null || true)" = "true" ]
}

# ---------- tjek før vi går i gang ----------

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || fail "du er på grenen \"$branch\". Skift til main først."

if [ -n "$(git status --porcelain)" ]; then
  git status --short
  fail "der er ændringer, som ikke er committet. Commit dem først, så computer og telefon får præcis den samme version."
fi

step "Tjekker GitHub"
git fetch --quiet origin main || fail "kunne ikke kontakte GitHub. Er der net?"
git merge-base --is-ancestor origin/main HEAD ||
  fail "main på GitHub har commits, du ikke har lokalt. Kør 'git pull' først."

version=$(git rev-parse HEAD | cut -c1-7)

# ---------- test og byg ----------

step "Kører tests"
npm test

step "Bygger mobilversionen (fanger web-fejl før push)"
npm run build:web

step "Bygger desktop-appen"
npm run tauri build

[ -d "$BUILT_APP" ] || fail "fandt ikke den byggede app i $BUILT_APP"

# ---------- skift appen ud ----------

step "Installerer $APP_NAME i /Applications"
if app_running; then
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  i=0
  while app_running; do
    i=$((i + 1))
    [ "$i" -le 15 ] || fail "$APP_NAME lukkede ikke (står der en dialog åben?). Luk appen selv, og kør igen."
    sleep 1
  done
fi
rm -rf "$INSTALLED_APP"
ditto "$BUILT_APP" "$INSTALLED_APP"
open "$INSTALLED_APP"

# ---------- push (udløser udrulning til telefonen) ----------

step "Sender til GitHub"
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
  printf '\nFærdig. Version %s er installeret på computeren.\n' "$version"
  echo "GitHub havde allerede denne version, så telefonen har den også (eller får den om lidt)."
  exit 0
fi
git push origin main

actions=$(git remote get-url origin | sed -e 's#^git@github.com:#https://github.com/#' -e 's#\.git$##')/actions
printf '\nFærdig. Version %s er installeret på computeren og sendt til GitHub.\n' "$version"
echo "Telefonen opdaterer sig selv inden for få minutter, næste gang du åbner appen."
echo "Følg udrulningen her: $actions"
