-- Decode the HTML entities the engine's parsers used to write into text.
--
-- Until 2026-10 the IGC and XCTask parsers passed every name through
-- `sanitizeText()`, which stripped tag-shaped runs and then HTML-encoded
-- & < > " ' — so a pilot called O'Brien was stored as `O&#39;Brien`, and a
-- React page (which encodes on output itself) showed exactly that. The parsers
-- now return the text as the file wrote it (web/engine/src/text.ts, scoring
-- change 052). New rows are stored plain; this decodes the rows written before.
--
-- The decode is the exact inverse of the old encoding. That encoder turned
-- every `&` into `&amp;`, so in a value it produced, every `&` begins one of
-- these five entities; decoding `&amp;` LAST means `&amp;lt;` (an original
-- literal "&lt;") comes back as "&lt;", not "<". The tag stripping was lossy
-- and cannot be undone — nothing here tries.
--
-- Only columns whose value came out of a parser are touched:
--   task_track.igc_pilot_name — the IGC header's pilot (track-upload.ts);
--   user_track.pilot, .glider — IGC header fields (routes/user-files.ts);
--   user_track.display_name   — "<pilot> - <date>" when the header named a
--                               pilot, otherwise the raw FILENAME, which was
--                               never encoded and is left alone;
--   user_task.display_name    — "<turnpoint name> (<code>)", or the code
--                               upper-cased (a slug, which carries no `&`).
-- None of these feeds a score: igc_pilot_name is shown beside the roster name
-- and never decides whose track it is, and the other two tables are a
-- signed-in user's personal library. So no score bump and no audit entry.

UPDATE task_track
   SET igc_pilot_name = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(igc_pilot_name,
         '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&')
 WHERE igc_pilot_name LIKE '%&%';

UPDATE user_track
   SET display_name = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(display_name,
         '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&')
 WHERE pilot IS NOT NULL AND display_name LIKE '%&%';

UPDATE user_track
   SET pilot = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(pilot,
         '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&')
 WHERE pilot LIKE '%&%';

UPDATE user_track
   SET glider = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(glider,
         '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&')
 WHERE glider LIKE '%&%';

UPDATE user_task
   SET display_name = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(display_name,
         '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&')
 WHERE display_name LIKE '%&%';
