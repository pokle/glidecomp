#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pypdfium2",
#     "pdfplumber",
#     "pillow",
# ]
# ///
"""Extraction pipeline for the FAI Sporting Code Section 7F (XC scoring) PDF.

Produces, in an output directory:
  raster/pNN.png     -- every page rendered at 150 dpi (the ground truth a
                        model reads to recover formulas, diagrams and layout
                        the text layer mangles)
  text/pNN.txt       -- pdfplumber layout-preserving text layer, for diffing
                        against the raster read
  annot/pNN.json     -- per-page annotations:
                          * highlight spans classified hg / pg (the colour
                            coding for discipline-specific rules) with the
                            exact words each highlight covers
                          * bounding boxes of embedded images (figures)
  figures/pNN-figK.png -- figure crops taken from the raster (image bboxes
                        clustered, padded, minimum-size filtered)
  summary.json       -- page count, per-page highlight/figure tallies

Usage:  uv run extract_s7f.py <input.pdf> <outdir>
(dependencies are declared inline above; uv resolves them on first run)

Colour classification (RGB fills observed in the 2024 edition):
  blue  (0.573, 0.804, 0.863) -> hang-gliding only
  orange (0.98, 0.749, 0.561) -> paragliding only
Red text would mark changes from the previous edition (none present in 2024).
A future edition may shift these values slightly; classify by hue, not equality.
"""

import json
import sys
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium
from PIL import Image

DPI = 150
SCALE = DPI / 72.0
MIN_FIGURE_PX = 40  # ignore decorative slivers smaller than this (raster px)


def classify_fill(rgb):
    """Classify a highlight fill colour as 'hg' (blue), 'pg' (orange) or None."""
    if not isinstance(rgb, (tuple, list)) or len(rgb) != 3:
        return None
    r, g, b = rgb
    if r > 0.9 and 0.6 < g < 0.85 and 0.4 < b < 0.7:
        return "pg"  # light orange
    if 0.4 < r < 0.7 and 0.7 < g < 0.9 and b > 0.75:
        return "hg"  # light blue
    return None


def words_in(page, bbox, pad=1.5):
    x0, top, x1, bottom = bbox
    out = []
    for w in page.extract_words():
        cx = (w["x0"] + w["x1"]) / 2
        cy = (w["top"] + w["bottom"]) / 2
        if x0 - pad <= cx <= x1 + pad and top - pad <= cy <= bottom + pad:
            out.append(w["text"])
    return " ".join(out)


def cluster_boxes(boxes, gap=12):
    """Union overlapping / nearby boxes so a figure made of segments crops once."""
    boxes = [list(b) for b in boxes]
    merged = True
    while merged:
        merged = False
        out = []
        while boxes:
            a = boxes.pop()
            for b in out:
                if not (a[2] + gap < b[0] or b[2] + gap < a[0]
                        or a[3] + gap < b[1] or b[3] + gap < a[1]):
                    b[0] = min(a[0], b[0]); b[1] = min(a[1], b[1])
                    b[2] = max(a[2], b[2]); b[3] = max(a[3], b[3])
                    merged = True
                    break
            else:
                out.append(a)
        boxes = out
    return boxes


def main(pdf_path, outdir):
    outdir = Path(outdir)
    for sub in ("raster", "text", "annot", "figures"):
        (outdir / sub).mkdir(parents=True, exist_ok=True)

    doc = pdfium.PdfDocument(str(pdf_path))
    for i in range(len(doc)):
        doc[i].render(scale=SCALE).to_pil().save(outdir / "raster" / f"p{i + 1:02d}.png")

    summary = {"pages": len(doc), "per_page": {}}
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            n = i + 1
            (outdir / "text" / f"p{n:02d}.txt").write_text(
                page.extract_text(layout=True) or "")

            highlights = []
            for r in page.rects:
                cls = classify_fill(r.get("non_stroking_color")) if r.get("fill") else None
                if cls:
                    bbox = (r["x0"], r["top"], r["x1"], r["bottom"])
                    highlights.append({
                        "discipline": cls,
                        "bbox": [round(v, 1) for v in bbox],
                        "text": words_in(page, bbox),
                    })
            highlights.sort(key=lambda h: h["bbox"][1])

            img_boxes = [(im["x0"], im["top"], im["x1"], im["bottom"])
                         for im in page.images]
            figures = []
            raster = Image.open(outdir / "raster" / f"p{n:02d}.png")
            for k, (x0, top, x1, bottom) in enumerate(
                    sorted(cluster_boxes(img_boxes), key=lambda b: b[1]), start=1):
                px = [int(x0 * SCALE) - 6, int(top * SCALE) - 6,
                      int(x1 * SCALE) + 6, int(bottom * SCALE) + 6]
                px = [max(0, px[0]), max(0, px[1]),
                      min(raster.width, px[2]), min(raster.height, px[3])]
                if px[2] - px[0] < MIN_FIGURE_PX or px[3] - px[1] < MIN_FIGURE_PX:
                    continue
                name = f"p{n:02d}-fig{k}.png"
                raster.crop(px).save(outdir / "figures" / name)
                figures.append({"file": name,
                                "bbox": [round(v, 1) for v in (x0, top, x1, bottom)]})

            annot = {"page": n, "highlights": highlights, "figures": figures}
            (outdir / "annot" / f"p{n:02d}.json").write_text(json.dumps(annot, indent=1))
            if highlights or figures:
                summary["per_page"][n] = {
                    "hg": sum(1 for h in highlights if h["discipline"] == "hg"),
                    "pg": sum(1 for h in highlights if h["discipline"] == "pg"),
                    "figures": len(figures),
                }

    (outdir / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
