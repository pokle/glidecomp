import { G, Text as SvgText, type TextProps } from 'react-native-svg';

/**
 * A label that stays legible where it crosses a line or a dot: drawn twice,
 * a surface-coloured stroke under the fill. (The website uses CSS
 * paint-order, which react-native-svg does not support.)
 */
export function HaloText({
  halo,
  children,
  ...props
}: TextProps & { halo: string; children: string }) {
  return (
    <G>
      <SvgText {...props} textAnchor={props.textAnchor ?? 'middle'} stroke={halo} strokeWidth={3} strokeLinejoin="round">
        {children}
      </SvgText>
      <SvgText {...props} textAnchor={props.textAnchor ?? 'middle'}>
        {children}
      </SvgText>
    </G>
  );
}
