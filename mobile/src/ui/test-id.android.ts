import { testID } from '@expo/ui/jetpack-compose/modifiers';

/**
 * The universal ListItem drops `testID` on Android; this Compose modifier
 * sets the test tag (exposed as a resource id) so Maestro can find the row.
 */
export function testIdModifiers(id: string | undefined) {
  return id ? [testID(id)] : undefined;
}
