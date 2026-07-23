-- Competition series (multi-task) scoring method — FAI S7F §13–15, S7A §5.2.5.
--
-- comp.series_scoring selects how a pilot's competition total is aggregated
-- from their per-task scores:
--   "total" — sum of all task scores (the default and historical behaviour;
--             the simple method used by HG comps and short series).
--   "ftv"   — Fixed Total Validity (S7F §15): score only each pilot's best
--             tasks until a fixed fraction of the total validity is reached;
--             the discard fraction is comp.ftv_factor (below).
--
-- comp.ftv_factor is the FTV *discard* fraction (S7A §5.2.5.1): 0.2 for comps
-- with ≤6 planned tasks, 0.25 for ≥7. NULL means "auto-derive from the number
-- of scoreable tasks"; an explicit value lets an admin override.
--
-- Existing competitions default to "total" so their published standings are
-- unchanged. New PG comps are set to "ftv" at creation time in the app layer
-- (the DB default stays "total" so no existing comp is silently re-scored).
-- Both values are also validated in the app layer (zod in validators.ts).

ALTER TABLE comp ADD COLUMN series_scoring TEXT NOT NULL DEFAULT 'total'
  CHECK ("series_scoring" IN ('total', 'ftv'));

ALTER TABLE comp ADD COLUMN ftv_factor REAL
  CHECK ("ftv_factor" IS NULL OR ("ftv_factor" > 0 AND "ftv_factor" < 1));
