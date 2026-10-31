# /// script
# dependencies = ["fonttools"]
# ///
"""
Rebuild the fonts the results record embeds (web/frontend/public/fonts/results-record/).

    uv run web/scripts/subset-results-record-fonts.py <NotoSans-Regular.ttf> <NotoSans-Bold.ttf>

The sources are Google Fonts' static Noto Sans (OFL-1.1), e.g. from the npm
package @expo-google-fonts/noto-sans (400Regular/, 700Bold/).

Why pre-subset here rather than let pdf-lib do it per document: pdf-lib's
fontkit subsetter draws the wrong glyphs for Noto Sans (the text extracts
correctly and renders as gibberish), so the record embeds these files whole.
Cutting them to the scripts pilot names are written in keeps that to about
200 KB a weight instead of 630 KB:

  Latin, Latin-1, Latin Extended A/B and Additional (Vietnamese), IPA
  modifiers and combining marks, Greek, Cyrillic, punctuation, currency,
  letterlike symbols, arrows and maths operators.

Ligatures are dropped (layout features kept: kerning and mark positioning
only) so a PDF's extracted text is the letters as typed, never an "ﬁ"
ligature an AI agent or a search has to undo. Hinting is dropped: a PDF
viewer scales the outlines itself.
"""
import sys
from fontTools import subset

UNICODES = ",".join([
    "U+0000-024F",  # Basic Latin, Latin-1, Latin Extended-A/B
    "U+02B0-02FF",  # spacing modifier letters
    "U+0300-036F",  # combining diacritical marks
    "U+0370-03FF",  # Greek
    "U+0400-052F",  # Cyrillic and Cyrillic Supplement
    "U+1E00-1EFF",  # Latin Extended Additional (Vietnamese)
    "U+2000-206F",  # general punctuation
    "U+20A0-20CF",  # currency
    "U+2100-214F",  # letterlike symbols
    "U+2190-21FF",  # arrows
    "U+2200-22FF",  # mathematical operators
])

OUT = "web/frontend/public/fonts/results-record"

for src, name in zip(sys.argv[1:3], ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"]):
    subset.main([
        src,
        f"--unicodes={UNICODES}",
        "--layout-features=kern,mark,mkmk,ccmp,locl",
        "--no-hinting",
        "--desubroutinize",
        "--name-IDs=*",
        "--name-languages=*",
        "--notdef-outline",
        f"--output-file={OUT}/{name}",
    ])
