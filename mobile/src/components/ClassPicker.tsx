import { Toggle } from '@/ui/form';
import { toggleClass } from '@/lib/task-form';

/** Which of the comp's classes fly this task: one switch per class. */
export function ClassPicker({
  classes,
  selected,
  onChange,
}: {
  classes: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <>
      {classes.map((cls) => (
        <Toggle
          key={cls}
          label={cls}
          value={selected.includes(cls)}
          onChange={() => onChange(toggleClass(selected, cls, classes))}
          testID={`class-${cls}`}
        />
      ))}
    </>
  );
}
