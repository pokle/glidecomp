import type { ListItem } from '@expo/ui';
import type { ComponentProps } from 'react';

type ListItemProps = ComponentProps<typeof ListItem>;

export interface ActionStyle {
  modifiers?: ListItemProps['modifiers'];
  colors?: ListItemProps['colors'];
}
