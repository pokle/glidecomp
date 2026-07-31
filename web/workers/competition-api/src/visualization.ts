// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * 3D-replay packing: turn a task's uploaded IGC tracks into the single binary
 * bundle the flight-replay viewer consumes. This is the Worker counterpart of
 * the offline build CLI — both call the same pure `packTracksFromIgc` in the
 * engine, so the runtime path and the build path stay identical.
 *
 * Bundle layout (one response, one fetch):
 *   [uint32 LE manifestByteLength][manifest JSON utf8][gzipped Float32 track data]
 * The frontend reads the length, parses the manifest, and gunzips the rest into
 * the interleaved [x,y,z,tRel] vertex array.
 */

import { packTracksFromIgc, type GAPParameters, type PilotIgc } from "@glidecomp/engine";
import { timezoneForXctsk } from "@glidecomp/engine/timezone";
import {
  hardFindingTitles,
  mapWithConcurrency,
  mergeStoredGapParamsJson,
  resolveTaskScoringConfig,
} from "./scoring";

/** How many tracks to fetch from R2 at once. The pack step already holds every
 * decompressed IGC in memory simultaneously, so fetching concurrently doesn't
 * raise peak memory — it only overlaps the per-object R2 round-trip latency,
 * which dominates the cold path (~150ms × N tracks when fetched one by one). */
const TRACK_FETCH_CONCURRENCY = 10;

/**
 * Cache key from the current task state (xctsk + comp timezone + track set +
 * penalties), so the bundle is recomputed automatically whenever an input
 * changes — the comp timezone is baked into the manifest, so an organizer
 * override must invalidate the bundle too. Mirrors the score cache key but
 * with its own prefix/version.
 *
 * The data-quality verdict is an input too, now that a HARD failure keeps a
 * track out of the bundle — and neither half of it moves the rest of the key
 * on its own. A verdict is computed LATER than the upload that it judges, so
 * `uploaded_at` is unchanged when a track first becomes withheld; and an
 * organiser reinstating one (S7A §4.4.6) touches only `quality_override`.
 * Both are folded in, so a bundle can never outlive the verdict it was packed
 * under.
 */
export async function compute3dvisCacheKey(
  taskId: number,
  db: D1Database
): Promise<string> {
  const task = await db
    .prepare(
      `SELECT t.xctsk, c.timezone FROM task t
       JOIN comp c ON t.comp_id = c.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<{ xctsk: string | null; timezone: string | null }>();

  const tracks = await db
    .prepare(
      `SELECT task_track_id, uploaded_at, quality_override
         FROM task_track WHERE task_id = ? ORDER BY task_track_id`
    )
    .bind(taskId)
    .all<{ task_track_id: number; uploaded_at: string; quality_override: number | null }>();

  // The stored HARD/soft verdict per track. Hashing the whole report is the
  // cheap way to be exactly right: any change to any finding moves the key,
  // and nothing has to know which fields the bundle happens to read.
  const verdicts = await db
    .prepare(
      `SELECT ta.task_track_id, ta.payload_json
         FROM track_analysis ta
         JOIN task_track tt ON tt.task_track_id = ta.task_track_id
        WHERE tt.task_id = ? AND ta.variant = 'quality'
        ORDER BY ta.task_track_id`
    )
    .bind(taskId)
    .all<{ task_track_id: number; payload_json: string }>();

  const stateString = [
    task?.xctsk ?? "",
    task?.timezone ?? "",
    ...tracks.results.map(
      (t) => `${t.task_track_id}:${t.uploaded_at}:${t.quality_override ?? 0}`
    ),
    ...verdicts.results.map((v) => `q${v.task_track_id}:${v.payload_json}`),
  ].join("|");

  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stateString)
  );
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);

  // v2: manifest format gained task.goalLine (goal LINE endpoints).
  // v3: gained per-pilot turnpoint reach times, turnpoint altitudes and
  // task.sssIndex (required-glide readout) — each prefix bump invalidates
  // bundles packed before the fields existed.
  // v4: tracks withheld by a HARD data-quality check are no longer packed, so
  // every bundle cut before this still carries them.
  return `3dvis:v4:${taskId}:${hex}`;
}

/**
 * Build the 3D-replay bundle for a task: fetch every track's IGC from R2,
 * decompress, pack (with GAP scoring for legend order), and frame the manifest
 * + gzipped vertex data into one binary blob.
 */
export async function buildTask3dvisBundle(
  taskId: number,
  db: D1Database,
  r2: R2Bucket
): Promise<Uint8Array> {
  const t0 = performance.now();
  const taskRow = await db
    .prepare(
      `SELECT t.task_id, t.comp_id, t.xctsk, t.gap_params AS task_gap_params,
              c.gap_params, c.timezone
       FROM task t JOIN comp c ON t.comp_id = c.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<{
      task_id: number;
      comp_id: number;
      xctsk: string | null;
      task_gap_params: string | null;
      gap_params: string | null;
      timezone: string | null;
    }>();

  if (!taskRow) throw new Error("Task not found");
  if (!taskRow.xctsk) throw new Error("Task has no xctsk definition");
  taskRow.gap_params = mergeStoredGapParamsJson(
    taskRow.gap_params,
    taskRow.task_gap_params
  );
  console.log(`[3dvis] task ${taskId}: loaded task row in ${(performance.now() - t0).toFixed(0)}ms`);

  // Comp-local IANA zone for the replay clock (#269): the comp setting when
  // present (task saves derive it, organizers can override), else derived
  // here from the task location so comps predating the setting still get a
  // comp-local clock. Undefined → the viewer falls back to the browser zone.
  const timezone = taskRow.timezone ?? timezoneForXctsk(taskRow.xctsk);

  const gapParams: Partial<GAPParameters> = taskRow.gap_params
    ? JSON.parse(taskRow.gap_params)
    : {};

  // All tracks for the task (every class — the replay shows the whole field).
  const tTracksStart = performance.now();
  const tracks = await db
    .prepare(
      `SELECT tt.task_track_id,
              tt.igc_filename,
              tt.quality_override,
              cp.comp_pilot_id,
              cp.registered_pilot_name AS pilot_name,
              cp.registered_pilot_civl_id AS civl_id
       FROM task_track tt
       JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
       WHERE tt.task_id = ?
       ORDER BY tt.task_track_id`
    )
    .bind(taskId)
    .all<{
      task_track_id: number;
      igc_filename: string;
      quality_override: number | null;
      comp_pilot_id: number;
      pilot_name: string;
      civl_id: string | null;
    }>();
  console.log(
    `[3dvis] task ${taskId}: found ${tracks.results.length} track rows in ${(performance.now() - tTracksStart).toFixed(0)}ms`
  );

  // A track a HARD data-quality check withheld is not this flight (S7A
  // §4.4.2 — wrong day, wrong place), so it must not be drawn any more than
  // it may be scored. Scoring and field analysis have always dropped these;
  // the replay did not, and one such track is enough to ruin the whole
  // picture: it enters the packed bounds like any other, and a file from
  // another country put a task's scene extent at 2,225 km against a real
  // field of 28 km, collapsing all 48 pilots into five pixels.
  //
  // The verdicts come from the same D1-only store scoring seeds (no R2 read
  // here), and carry the same two rules: an organiser's `quality_override`
  // reinstates the track (§4.4.6), and a track with NO stored verdict is
  // UNKNOWN, never assumed bad — it stays in, exactly as partitionByQuality
  // keeps it in the scored set.
  const quality = (await resolveTaskScoringConfig(taskId, db)).quality;
  const withheld: { name: string; reasons: string[] }[] = [];
  const drawable = tracks.results.filter((track) => {
    const report = quality.byTrackId.get(track.task_track_id);
    if (!report?.hardFailed || track.quality_override) return true;
    withheld.push({ name: track.pilot_name, reasons: hardFindingTitles(report) });
    return false;
  });
  if (withheld.length > 0) {
    console.log(
      `[3dvis] task ${taskId}: withheld ${withheld.length} track(s) on data quality — ` +
        withheld.map((w) => `${w.name} (${w.reasons.join("; ")})`).join(", ")
    );
  }

  // Fetch + decompress IGC files with bounded concurrency (same pattern as the
  // scoring path) — cold-path time is dominated by R2 round trips, not CPU.
  const tFetchStart = performance.now();
  const fetched = await mapWithConcurrency(
    drawable,
    TRACK_FETCH_CONCURRENCY,
    async (track): Promise<PilotIgc | null> => {
      const tTrackStart = performance.now();
      const object = await r2.get(track.igc_filename);
      if (!object) {
        console.warn(`[3dvis] task ${taskId}: missing R2 object ${track.igc_filename}`);
        return null;
      }
      const compressed = await object.arrayBuffer();
      const stream = new Response(compressed).body!.pipeThrough(new DecompressionStream("gzip"));
      const igc = new TextDecoder().decode(await new Response(stream).arrayBuffer());
      console.log(
        `[3dvis] task ${taskId}: fetched+decompressed ${track.igc_filename} ` +
          `(${compressed.byteLength}B gz → ${igc.length}B igc) in ${(performance.now() - tTrackStart).toFixed(0)}ms`
      );
      return {
        id: track.civl_id ?? String(track.comp_pilot_id),
        name: track.pilot_name,
        igc,
      };
    }
  );
  const pilots: PilotIgc[] = fetched.filter((p): p is PilotIgc => p !== null);
  console.log(
    `[3dvis] task ${taskId}: fetched ${pilots.length}/${drawable.length} tracks from R2 ` +
      `in ${(performance.now() - tFetchStart).toFixed(0)}ms total`
  );

  if (pilots.length === 0) throw new Error("No tracks to pack");

  const tPackStart = performance.now();
  const { manifest, data } = packTracksFromIgc({
    pilots,
    taskXctsk: taskRow.xctsk,
    timezone,
    gapParams,
  });
  console.log(
    `[3dvis] task ${taskId}: packed ${pilots.length} tracks (${data.length} floats) ` +
      `in ${(performance.now() - tPackStart).toFixed(0)}ms`
  );

  // gzip the Float32 vertex data (matches the static asset's tracks.bin.gz).
  const tGzipStart = performance.now();
  const dataBuf = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;
  const gzStream = new Response(dataBuf).body!.pipeThrough(new CompressionStream("gzip"));
  const gz = new Uint8Array(await new Response(gzStream).arrayBuffer());
  console.log(
    `[3dvis] task ${taskId}: gzipped vertex data ${dataBuf.byteLength}B → ${gz.length}B ` +
      `in ${(performance.now() - tGzipStart).toFixed(0)}ms`
  );

  // [uint32 manifestLen][manifest json][gz data]
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const bundle = new Uint8Array(4 + manifestBytes.length + gz.length);
  new DataView(bundle.buffer).setUint32(0, manifestBytes.length, true);
  bundle.set(manifestBytes, 4);
  bundle.set(gz, 4 + manifestBytes.length);
  console.log(
    `[3dvis] task ${taskId}: bundle built in ${(performance.now() - t0).toFixed(0)}ms total (${bundle.length}B)`
  );
  return bundle;
}
