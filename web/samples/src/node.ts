/**
 * Node/Bun-only utilities for resolving sample comp file paths on disk.
 * Do NOT import this from browser code — use the main export instead.
 */
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export { SAMPLE_COMPS, type SampleComp, type SampleCompGAPParams } from './index';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the absolute directory path for a sample comp's files on disk.
 */
export function resolveCompDir(compId: string): string {
  return resolve(__dirname, '..', 'comps', compId);
}

/**
 * Resolve the absolute path to a specific file within a sample comp.
 */
export function resolveCompFile(compId: string, filename: string): string {
  return resolve(resolveCompDir(compId), filename);
}
