import { parseIGC, parseXCTask, resolveTurnpointSequence } from "@glidecomp/engine";

/**
 * Preprocess a track for a task.
 */
export async function preprocessTrack(
  db: D1Database,
  r2: R2Bucket,
  taskId: number,
  taskTrackId: number,
  igcData?: ArrayBuffer
): Promise<void> {
  // 1. Get task's xctsk
  const task = await db
    .prepare("SELECT xctsk FROM task WHERE task_id = ?")
    .bind(taskId)
    .first<{ xctsk: string | null }>();

  if (!task || !task.xctsk) return;

  try {
    let data = igcData;

    // 2. If no igcData provided, fetch from R2
    if (!data) {
      const track = await db
        .prepare("SELECT igc_filename FROM task_track WHERE task_track_id = ?")
        .bind(taskTrackId)
        .first<{ igc_filename: string }>();

      if (!track) return;

      const object = await r2.get(track.igc_filename);
      if (!object) return;
      data = await object.arrayBuffer();
    }

    // 3. Decompress and parse IGC
    const decompressed = await new Response(data)
      .body!.pipeThrough(new DecompressionStream("gzip"))
      .arrayBuffer();
    const igcText = new TextDecoder().decode(decompressed);
    const igc = parseIGC(igcText);

    // 4. Parse XCTask and resolve sequence
    const xctsk = parseXCTask(JSON.parse(task.xctsk));
    const result = resolveTurnpointSequence(xctsk, igc.fixes);

    // 5. Update track with flight_data
    const flightData = {
      flownDistance: result.flownDistance,
      speedSectionTime: result.speedSectionTime,
      madeGoal: result.madeGoal,
      essReaching: result.essReaching,
      sssReaching: result.sssReaching,
      lastTurnpointReached: result.lastTurnpointReached,
    };

    await db
      .prepare("UPDATE task_track SET flight_data = ? WHERE task_track_id = ?")
      .bind(JSON.stringify(flightData), taskTrackId)
      .run();
  } catch (err) {
    console.error("Preprocessing failed:", err);
    throw err;
  }
}
