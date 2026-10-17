import { requireOptionalNativeModule } from 'expo';

const ShareIntake = requireOptionalNativeModule<{ displayName(uri: string): string | null }>('ShareIntake');

/**
 * The file's own name, from the content provider that handed it over
 * (modules/share-intake). Null when the provider names nothing.
 */
export function displayName(uri: string): string | null {
  if (!uri.startsWith('content://')) return null;
  try {
    return ShareIntake?.displayName(uri) ?? null;
  } catch {
    return null;
  }
}
