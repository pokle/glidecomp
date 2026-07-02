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

/**
 * Cache key from the current task state (xctsk + track set + penalties), so the
 * bundle is recomputed automatically whenever an input changes. Mirrors the
 * score cache key but with its own prefix/version.
 */
export async function compute3dvisCacheKey(
  taskId: number,
  db: D1Database
): Promise<string> {
  const task = await db
    .prepare("SELECT xctsk FROM task WHERE task_id = ?")
    .bind(taskId)
    .first<{ xctsk: string | null }>();

  const tracks = await db
    .prepare(
      `SELECT task_track_id, uploaded_at FROM task_track WHERE task_id = ? ORDER BY task_track_id`
    )
    .bind(taskId)
    .all<{ task_track_id: number; uploaded_at: string }>();

  const stateString = [
    task?.xctsk ?? "",
    ...tracks.results.map((t) => `${t.task_track_id}:${t.uploaded_at}`),
  ].join("|");

  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stateString)
  );
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);

  return `3dvis:v1:${taskId}:${hex}`;
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
      `SELECT t.task_id, t.comp_id, t.xctsk, c.gap_params
       FROM task t JOIN comp c ON t.comp_id = c.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<{ task_id: number; comp_id: number; xctsk: string | null; gap_params: string | null }>();

  if (!taskRow) throw new Error("Task not found");
  if (!taskRow.xctsk) throw new Error("Task has no xctsk definition");
  console.log(`[3dvis] task ${taskId}: loaded task row in ${(performance.now() - t0).toFixed(0)}ms`);

  // Optional IANA timezone the seed stashes in the task JSON (geo-tz is
  // node-only, so it can't be resolved here).
  let timezone: string | undefined;
  try {
    const raw = JSON.parse(taskRow.xctsk) as { _timezone?: unknown };
    if (typeof raw._timezone === "string") timezone = raw._timezone;
  } catch {
    /* not JSON we can read — leave undefined */
  }

  const gapParams: Partial<GAPParameters> = taskRow.gap_params
    ? JSON.parse(taskRow.gap_params)
    : {};

  // All tracks for the task (every class — the replay shows the whole field).
  const tTracksStart = performance.now();
  const tracks = await db
    .prepare(
      `SELECT tt.igc_filename,
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
      igc_filename: string;
      comp_pilot_id: number;
      pilot_name: string;
      civl_id: string | null;
    }>();
  console.log(
    `[3dvis] task ${taskId}: found ${tracks.results.length} track rows in ${(performance.now() - tTracksStart).toFixed(0)}ms`
  );

  // Fetch + decompress IGC files sequentially to keep peak memory manageable.
  const tFetchStart = performance.now();
  const pilots: PilotIgc[] = [];
  for (const track of tracks.results) {
    const tTrackStart = performance.now();
    const object = await r2.get(track.igc_filename);
    if (!object) {
      console.warn(`[3dvis] task ${taskId}: missing R2 object ${track.igc_filename}`);
      continue;
    }
    const compressed = await object.arrayBuffer();
    const stream = new Response(compressed).body!.pipeThrough(new DecompressionStream("gzip"));
    const igc = new TextDecoder().decode(await new Response(stream).arrayBuffer());
    pilots.push({
      id: track.civl_id ?? String(track.comp_pilot_id),
      name: track.pilot_name,
      igc,
    });
    console.log(
      `[3dvis] task ${taskId}: fetched+decompressed ${track.igc_filename} ` +
        `(${compressed.byteLength}B gz → ${igc.length}B igc) in ${(performance.now() - tTrackStart).toFixed(0)}ms`
    );
  }
  console.log(
    `[3dvis] task ${taskId}: fetched ${pilots.length}/${tracks.results.length} tracks from R2 ` +
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
