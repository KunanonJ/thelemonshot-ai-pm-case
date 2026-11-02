#!/usr/bin/env bash
# Builds the single-file deck from src/ and exports a PDF (one slide per 1280x720 page).
# Usage: ./build.sh            -> HTML + PDF
#        ./build.sh --no-pdf   -> HTML only
set -euo pipefail
cd "$(dirname "$0")"

OUT="TheLemonShot_AI-PM-Case.html"
PDF="TheLemonShot_AI-PM-Case.pdf"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

cat src/00-head.html src/10-slides-a.html src/20-slides-b.html src/30-slides-c.html src/40-appendix.html src/90-tail.html > "$OUT"
echo "Built $OUT ($(grep -c 'class="slide' "$OUT") slides)"

if [[ "${1:-}" != "--no-pdf" ]]; then
  if [[ -x "$CHROME" ]]; then
    "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --run-all-compositor-stages-before-draw \
      --virtual-time-budget=8000 --print-to-pdf="$PWD/$PDF" "file://$PWD/$OUT" 2>/dev/null
    echo "Exported $PDF"
  else
    echo "Chrome not found; open $OUT in a browser and print to PDF (landscape, no margins)."
  fi
fi
