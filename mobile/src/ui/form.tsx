/**
 * The few form pieces the native list does not have — a labelled text field,
 * a filled button, a text button, a status line — in React Native, themed
 * from the navigation theme so they sit beside the grouped list in both
 * light and dark. Every target is at least 44 points tall.
 */
import { useTheme } from 'expo-router';
import type { ComponentRef, PropsWithChildren } from 'react';
import { forwardRef } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';

import { useChartPalette } from '@/charts/palette';

/** A scrolling form screen that keeps its focused field above the keyboard. */
export function FormScreen({ children, testID }: PropsWithChildren<{ testID?: string }>) {
  const { colors } = useTheme();
  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        testID={testID}>
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** A titled card of fields. */
export function FormCard({ title, children }: PropsWithChildren<{ title?: string }>) {
  const { colors } = useTheme();
  const palette = useChartPalette();
  return (
    <View style={styles.cardWrap}>
      {title ? (
        <Text style={[styles.cardTitle, { color: palette.muted }]} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      <View style={[styles.card, { backgroundColor: colors.card }]}>{children}</View>
    </View>
  );
}

export const Field = forwardRef<ComponentRef<typeof TextInput>, TextInputProps & { label: string }>(function Field(
  { label, style, ...input },
  ref,
) {
  const { colors } = useTheme();
  const palette = useChartPalette();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: palette.muted }]}>{label}</Text>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        placeholderTextColor={palette.muted}
        style={[styles.input, { color: colors.text, borderColor: colors.border }, style]}
        {...input}
      />
    </View>
  );
});

export function PrimaryButton({
  title,
  onPress,
  pending = false,
  pendingLabel,
  disabled = false,
  testID,
}: {
  title: string;
  onPress: () => void;
  pending?: boolean;
  /** Read out while `pending`: "Sending your code". */
  pendingLabel?: string;
  disabled?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  const inactive = disabled || pending;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={pending && pendingLabel ? pendingLabel : title}
      accessibilityState={{ disabled: inactive, busy: pending }}
      onPress={inactive ? undefined : onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.primary,
        { backgroundColor: colors.primary, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}>
      {pending ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{title}</Text>}
    </Pressable>
  );
}

export function TextButton({
  title,
  onPress,
  disabled = false,
  testID,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={disabled ? undefined : onPress}
      hitSlop={8}
      testID={testID}
      style={({ pressed }) => [styles.textButton, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
      <Text style={[styles.textButtonText, { color: colors.primary }]}>{title}</Text>
    </Pressable>
  );
}

/**
 * Error text: Apple's high-contrast system reds, which clear 4.5:1 on the
 * card in both themes (the plain system red does not on white).
 */
const ERROR_INK = { light: '#d70015', dark: '#ff6961' };

/** A status or error line, announced when it changes. */
export function FormMessage({ kind, children, testID }: { kind: 'status' | 'error'; children: string; testID?: string }) {
  const { colors, dark } = useTheme();
  return (
    <Text
      accessibilityRole={kind === 'error' ? 'alert' : 'text'}
      accessibilityLiveRegion="polite"
      testID={testID}
      style={[styles.message, { color: kind === 'error' ? ERROR_INK[dark ? 'dark' : 'light'] : colors.text }]}>
      {children}
    </Text>
  );
}

/**
 * One of a few values, as a row of buttons — the form's segmented control.
 * Each choice is a 44 pt target and says whether it is the selected one.
 */
export function Choices<T extends string>({
  label,
  value,
  choices,
  onChange,
  testID,
}: {
  label: string;
  value: T;
  choices: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  testID?: string;
}) {
  const { colors } = useTheme();
  const palette = useChartPalette();
  return (
    <View style={styles.field} testID={testID}>
      <Text style={[styles.label, { color: palette.muted }]}>{label}</Text>
      <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {choices.map((c) => {
          const on = c.value === value;
          return (
            <Pressable
              key={c.value}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, checked: on }}
              onPress={() => onChange(c.value)}
              testID={testID ? `${testID}-${c.value}` : undefined}
              style={[
                styles.choice,
                { borderColor: on ? colors.primary : colors.border, backgroundColor: on ? colors.primary : 'transparent' },
              ]}>
              <Text style={[styles.choiceText, { color: on ? '#fff' : colors.text }]}>{c.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** An on/off setting: the platform's own switch, with its label and an optional line under it. */
export function Toggle({
  label,
  hint,
  value,
  onChange,
  testID,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  testID?: string;
}) {
  const { colors } = useTheme();
  const palette = useChartPalette();
  return (
    <View style={styles.toggle}>
      <View style={styles.toggleText}>
        <Text style={[styles.toggleLabel, { color: colors.text }]}>{label}</Text>
        {hint ? <Text style={[styles.hint, { color: palette.muted }]}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} testID={testID} />
    </View>
  );
}

/** A destructive action at the foot of a form: Delete task, Remove pilot. */
export function DangerButton({ title, onPress, testID }: { title: string; onPress: () => void; testID?: string }) {
  const { dark } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.danger, { borderColor: ERROR_INK[dark ? 'dark' : 'light'], opacity: pressed ? 0.6 : 1 }]}>
      <Text style={[styles.primaryText, { color: ERROR_INK[dark ? 'dark' : 'light'] }]}>{title}</Text>
    </Pressable>
  );
}

/** Quieter explanatory text under a field or a button. */
export function FormHint({ children }: { children: string }) {
  const palette = useChartPalette();
  return <Text style={[styles.hint, { color: palette.muted }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 16, gap: 20 },
  cardWrap: { gap: 6 },
  cardTitle: { fontSize: 13, textTransform: 'uppercase', marginLeft: 16 },
  card: { borderRadius: 12, padding: 16, gap: 14 },
  field: { gap: 6 },
  label: { fontSize: 13 },
  input: { fontSize: 17, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12 },
  primary: { minHeight: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  textButton: { minHeight: 44, justifyContent: 'center' },
  textButtonText: { fontSize: 17 },
  message: { fontSize: 15, lineHeight: 20 },
  hint: { fontSize: 13, lineHeight: 18 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minHeight: 44, minWidth: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, justifyContent: 'center' },
  choiceText: { fontSize: 15, fontWeight: '500' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  toggleText: { flex: 1, gap: 2 },
  toggleLabel: { fontSize: 17 },
  danger: { minHeight: 50, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
