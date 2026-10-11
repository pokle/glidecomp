import { HStack } from '@expo/ui/swift-ui';
import { Fragment, type ReactNode } from 'react';

/** A row's trailing items side by side: value, then chevron or check mark. */
export function trailing(items: ReactNode[]): ReactNode {
  return (
    <HStack spacing={6}>
      {items.map((item, i) => (
        <Fragment key={i}>{item}</Fragment>
      ))}
    </HStack>
  );
}
