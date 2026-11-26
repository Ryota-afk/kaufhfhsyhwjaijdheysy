#!/usr/bin/env bash
# 照合の基準にする Pokémon Showdown（MITライセンス）を、決めたコミットで取得して組み立てる。
# 取得先は vendor/showdown（リポジトリには入れない）。
set -euo pipefail
COMMIT="$(cat "$(dirname "$0")/COMMIT")"
DIR="$(cd "$(dirname "$0")/../.." && pwd)/vendor/showdown"
if [ -f "$DIR/.built-$COMMIT" ]; then
  echo "Showdown $COMMIT は組み立て済み"
  exit 0
fi
rm -rf "$DIR"
mkdir -p "$DIR"
cd "$DIR"
git init -q
git remote add origin https://github.com/smogon/pokemon-showdown.git
git fetch -q --depth 1 origin "$COMMIT"
git checkout -q FETCH_HEAD
npm ci --ignore-scripts --no-audit --no-fund
node build
touch ".built-$COMMIT"
echo "Showdown $COMMIT を組み立てた"
