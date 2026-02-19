#!/usr/bin/env bash
# build.sh — Assemble a self-contained static bundle in dist/
# Usage: cd wifi-checker && bash build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST="$SCRIPT_DIR/dist"
DESIGN_SYSTEM="$SCRIPT_DIR/../design-system"

# 1. Clean / create dist
rm -rf "$DIST"
mkdir -p "$DIST"

# 2. Copy app files
cp "$SCRIPT_DIR/index.html" "$DIST/index.html"
cp "$SCRIPT_DIR/app.js"     "$DIST/app.js"

# 3. Copy design-system CSS
cp "$DESIGN_SYSTEM/tokens.css"     "$DIST/tokens.css"
cp "$DESIGN_SYSTEM/components.css" "$DIST/components.css"

# 4. Patch CSS paths in dist/index.html (parent-relative → local)
sed -i '' \
  's|href="\.\./design-system/tokens\.css"|href="tokens.css"|g' \
  "$DIST/index.html"

sed -i '' \
  's|href="\.\./design-system/components\.css"|href="components.css"|g' \
  "$DIST/index.html"

echo "✓ Built wifi-checker bundle in dist/"
echo "  Serve with: python3 -m http.server 8080 -d dist"
