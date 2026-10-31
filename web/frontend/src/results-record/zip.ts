/**
 * The results record's data as a ZIP (`/comp/:id/scores.zip`): the same files
 * the PDF carries as attachments (attachments.ts), for a reader whose PDF
 * viewer cannot reach them — macOS Preview lists no attachments at all.
 *
 * The PDF stays the record to keep; this is the easy way to get its data into
 * a spreadsheet today. Everything sits in one folder named like the PDF, so
 * unzipping never scatters seven files into someone's Downloads.
 *
 * Pure (fflate, no Node APIs), like the rest of src/results-record/.
 */
import { strToU8, zipSync, type Zippable } from "fflate";
import type { ResultsRecordLoaderData } from "../react/loaders";
import { buildRecordFiles, type RecordMeta } from "./attachments";
import { resultsRecordFilename } from "./build";

export function buildResultsZip(data: ResultsRecordLoaderData, meta: RecordMeta): Uint8Array {
  const folder = resultsRecordFilename(data.comp, meta.generatedAt, "zip").replace(/\.zip$/, "");
  const entries: Zippable = {};
  for (const file of buildRecordFiles(data, meta)) {
    entries[`${folder}/${file.name}`] = [strToU8(file.content), { mtime: meta.generatedAt }];
  }
  return zipSync(entries, { level: 6 });
}
