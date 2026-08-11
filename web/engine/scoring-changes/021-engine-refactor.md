# Engine complexity refactor

No behaviour change — internal refactor only (engine complexity review).
Order-sensitive scoring signatures became options objects, the longest
scoring/sequence functions were split into named helpers, the four
oversized modules were broken into per-concern files (re-exported from
the same entry modules), and the FAI validity/arrival cubics were pulled
into named constants via a poly3 helper (identical arithmetic). Every
scoring number is unchanged; the fingerprint moved because the hashed
sources were reorganised, so the guard requires a bump. The cache roll is
harmless — scores recompute identically.
