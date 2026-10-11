/**
 * Scores export through the share sheet: the same CSV the website's
 * scores.csv serves (buildScoresCsv in @glidecomp/client), with URLs that
 * point at glidecomp.com so they open from a spreadsheet.
 */
import { buildScoresCsv, scoresCsvFilename } from '@glidecomp/client/scores-csv';
import type { CompScores } from '@glidecomp/client/types';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export async function shareScoresCsv(scores: CompScores, compName: string): Promise<void> {
  const csv = buildScoresCsv(scores, { compName, origin: 'https://glidecomp.com' });
  const file = new File(Paths.cache, scoresCsvFilename(compName));
  if (file.exists) file.delete();
  file.create();
  file.write(csv);
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
    dialogTitle: compName,
  });
}
