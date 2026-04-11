#!/usr/bin/env bash
# Fetches the latest Google Fonts directory and regenerates
# web/frontend/src/google-fonts.ts with the full font list.
#
# Usage:  bash web/scripts/update-google-fonts.sh

set -euo pipefail

OUTFILE="web/frontend/src/google-fonts.ts"

curl -s "https://fonts.google.com/metadata/fonts" | python3 -c "
import json, sys
d = json.load(sys.stdin)
families = [f['family'] for f in d['familyMetadataList']]
print('/**')
print(' * Complete Google Fonts directory (bundled from fonts.google.com/metadata/fonts).')
print(' * ~%d font families. Font CSS is loaded at runtime from fonts.googleapis.com.' % len(families))
print(' */')
print()
print('export const LOCAL_FONTS = [')
print('  \"Roboto\",')
print('  \"Alte Haas Grotesk\",')
print('  \"Atkinson Hyperlegible Next\",')
print('] as const;')
print()
print('const LOCAL_SET = new Set<string>(LOCAL_FONTS);')
print()
print('export const GOOGLE_FONTS: string[] = [')
line = '  '
for f in families:
    entry = json.dumps(f) + ', '
    if len(line) + len(entry) > 110:
        print(line)
        line = '  ' + entry
    else:
        line += entry
if line.strip():
    print(line)
print('];')
print()
print('/** Local fonts first, then all Google Fonts. */')
print('export function getAllFonts(): string[] {')
print('  return [...LOCAL_FONTS, ...GOOGLE_FONTS.filter(f => !LOCAL_SET.has(f))];')
print('}')
" > "$OUTFILE"

COUNT=$(python3 -c "
import re, sys
text = open('$OUTFILE').read()
print(len(re.findall(r'\"[^\"]+\"', text.split('GOOGLE_FONTS')[1].split('];')[0])))
")

echo "Updated $OUTFILE with $COUNT Google Fonts."
