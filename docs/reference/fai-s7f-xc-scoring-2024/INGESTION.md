# How this reference was produced (and how to ingest a future edition)

`s7f-xc-scoring-2024.md` is a machine-optimised transcription of the FAI
Sporting Code **Section 7F — XC Scoring, 1 May 2024** edition
(`sporting_code_s7_f_-_xc_scoring_2024.pdf` from
fai.org/civl/documents). The PDF itself is not committed; the transcription,
the figure crops and this process are.

## Why a transcription at all

Three properties of the source PDF defeat naive text extraction, which is what
an LLM (or a `pdftotext` pipeline) sees by default:

1. **Formulas are Word equation objects.** The text layer serialises them out
   of order, with lost superscripts, radicals, and fraction bars — e.g. the
   distance-validity and time-points formulas come out as unreadable digit
   soup. Every formula was therefore re-read from a 150 dpi raster of the page
   and rewritten as LaTeX.
2. **Discipline rules are colour-coded, not worded.** Blue highlight = applies
   to hang-gliding only; orange highlight = paragliding only (legend on PDF
   p. 8, §1.4). Plain text extraction silently drops the distinction, which
   changes the meaning of the rule. The highlight rectangles were extracted
   programmatically (fill colours ≈ `rgb(0.573, 0.804, 0.863)` blue and
   `rgb(0.98, 0.749, 0.561)` orange), matched to the words they cover, and
   re-expressed as explicit `**HG only:**` / `**PG only:**` markers.
3. **Annex A's pseudocode text layer has no spaces** (`functiongetShortestPath`),
   and its diagrams (and all figures) are images. Code was re-spaced from the
   raster; figures are cropped out of the raster and described in prose beside
   each image reference.

Red text would mark changes from the previous edition (§1.3); the 2024 file
contains none, so no change-markers appear in the transcription.

## Pipeline

`extract_s7f.py` (committed beside this file) does the mechanical half. It is
a [uv script](https://docs.astral.sh/uv/guides/scripts/) with its dependencies
declared inline (PEP 723), so there is nothing to install first:

```
uv run extract_s7f.py sporting_code_s7f.pdf workdir/
```

It emits per page: a 150 dpi raster PNG, the layout-preserving text layer, a
JSON annotation of highlight spans (classified `hg`/`pg`, with the covered
words) and embedded-image bounding boxes, plus figure crops (image boxes
clustered, padded, minimum-size filtered) and a `summary.json`.

The judgement half is a model pass over the rasters: each page image is read
alongside its text layer and annotation JSON, and transcribed to Markdown
under the conventions below. In this run the document was split into eight
page ranges transcribed by parallel agents, then concatenated, spot-checked
against the rasters (every formula-bearing page re-verified), and the figure
set pruned to the crops actually referenced.

## Transcription conventions

- Headings keep the S7F numbering (`## 8`, `### 8.3`, `#### 8.3.1`); nothing
  is renumbered or reordered.
- `<!-- PDF p.NN -->` comments mark where each source page begins, so any
  passage can be checked against the original quickly.
- Discipline-exclusive text: whole paragraphs as `> **HG only:** …` /
  `> **PG only:** …` blockquotes; whole subsections as
  `*(Hang-gliding only.)*` under the heading; short phrases inline as
  `**[HG: …]**` / `**[PG: …]**`.
- Math is GitHub-flavoured LaTeX: `$$ … $$` display blocks, `$ … $` inline,
  multi-letter variable names as `\mathit{…}` matching the document's own
  symbols.
- Figures are `![alt](figures/pNN-figK.png)` references, each followed by a
  caption and a prose description complete enough that a text-only reader
  loses nothing.
- Annex A listings are fenced ```` ```c ```` blocks with spacing and
  indentation restored from the raster; identifiers and comments verbatim.
- Wording and spelling are the document's own (US spelling included) — this is
  a quotation of an external spec, exempt from the repo's Australian English
  rule.

## Ingesting a future edition

1. Download the new PDF from the CIVL documents page; note its edition date.
2. Run `extract_s7f.py` over it. Check `summary.json`: the highlight-colour
   classifier matches by hue range, but eyeball one highlighted page to
   confirm blue/orange still mean HG/PG (§1.4 legend).
3. **Look for red text first** (§1.3: red marks what changed). The script's
   approach — filter chars whose fill colour is predominantly red — tells you
   exactly which pages need attention; `git diff` against this transcription
   is then mostly confirmation.
4. Re-transcribe changed pages from their rasters under the conventions above;
   leave untouched sections alone so the diff stays reviewable.
5. Re-crop any changed figures; delete crops no longer referenced.
6. Update the edition date in the transcription's front matter and in the
   first line of this file, and record notable rule changes in the PR body.

## Known quirks of the 2024 file

See the "Source-extraction notes" appendix at the bottom of
`s7f-xc-scoring-2024.md` for the full list of places where the text layer
actively lies (garbled formulas, dropped spaces, reading-order faults) and
where the source itself is inconsistent (e.g. Annex A pages still carry the
previous edition's "1st May 2023" running header).
