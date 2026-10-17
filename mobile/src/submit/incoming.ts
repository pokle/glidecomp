/**
 * Tracklogs that arrive from outside the app: "Open in GlideComp" from Files,
 * an instrument's companion app, or an email attachment (stage 5).
 *
 * The operating system hands the app a URL — `file://` on iOS (a copy in the
 * app's Inbox), `content://` on Android, where a Share (ACTION_SEND) is turned
 * into the same shape by modules/share-intake. `+native-intent.tsx` catches
 * it before the router does, parks it here and opens the submit sheet, which
 * takes it.
 *
 * Read promptly: an Android content URI is only readable while the app holds
 * the permission it came with.
 */
import { igcPilotNameFromText, looksLikeIgc, NOT_AN_IGC_MESSAGE, tooLargeReason } from '@glidecomp/client/submit';
import { File } from 'expo-file-system';
import { gzipSync, strFromU8 } from 'fflate';
import { useSyncExternalStore } from 'react';

import { isIncomingFileUrl } from '@/lib/incoming-url';

import { displayName as providerName } from './display-name';

let pending: string | null = null;
const listeners = new Set<() => void>();

/** Park a URL for the submit sheet. */
export function receiveIncomingFile(url: string) {
  pending = url;
  listeners.forEach((l) => l());
}

/** The URL waiting for the sheet, if any. */
export function useIncomingFile(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
  );
}

/** The sheet has it now. */
export function takeIncomingFile(url: string) {
  if (pending === url) pending = null;
  listeners.forEach((l) => l());
}

export { isIncomingFileUrl };

/** A tracklog ready to queue. */
export interface PickedTrack {
  name: string;
  rawBytes: number;
  gz: Uint8Array;
  /** The pilot the file names, shown so a pilot can catch somebody else's file. */
  pilotName: string | null;
}

/** Why a picked file cannot be submitted, in a sentence for the pilot. */
export class TrackFileError extends Error {}

/**
 * The file's name as the pilot knows it, or null. A content URI's last
 * segment ("msf:1000000019") is not a name, so it is never shown as one.
 */
function displayName(uri: string, file: File): string | null {
  const fromProvider = providerName(uri);
  if (fromProvider) return fromProvider;
  if (uri.startsWith('content://')) return null;
  try {
    return decodeURIComponent(file.name);
  } catch {
    return file.name;
  }
}

/**
 * Read a picked or shared file into a tracklog: checked, its pilot read from
 * the header, and gzipped — the body every upload route takes.
 */
export async function readTrackFile(uri: string): Promise<PickedTrack> {
  const file = new File(uri);
  let bytes: Uint8Array;
  try {
    bytes = await file.bytes();
  } catch {
    throw new TrackFileError('GlideComp couldn’t read that file. Try choosing it again.');
  }
  const text = strFromU8(bytes, true);
  const name = displayName(uri, file);
  if (!looksLikeIgc(name, text)) throw new TrackFileError(NOT_AN_IGC_MESSAGE);
  const gz = gzipSync(bytes);
  const tooLarge = tooLargeReason(bytes.byteLength, gz.byteLength);
  if (tooLarge) throw new TrackFileError(tooLarge);
  // iOS leaves its "Open in" copies in the app's Inbox for good; the queue
  // keeps its own copy, so this one can go.
  if (uri.includes('/Documents/Inbox/')) {
    try {
      file.delete();
    } catch {
      // Harmless: the Inbox is the app's own.
    }
  }
  return {
    name: name ?? 'Tracklog',
    rawBytes: bytes.byteLength,
    gz,
    pilotName: igcPilotNameFromText(text),
  };
}
