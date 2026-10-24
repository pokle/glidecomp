import { Icon } from '@expo/ui';
import type { ReactNode } from 'react';
import { PlatformColor } from 'react-native';

/** A row's "shows this on the map" mark: the SF Symbol Maps uses. */
export function mapPin(): ReactNode {
  return <Icon name="mappin.circle" size={22} color={PlatformColor('link')} />;
}
