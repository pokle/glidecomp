/**
 * Which pilot class an analysis report is showing — on the comp analysis and
 * on every task analysis page, in the page bar's second layer, because it
 * filters the whole report rather than any one section of it.
 *
 * Up to five classes it is a segmented control: every class on screen, one
 * tap from any other. Past that, segments stop being glanceable (and stop
 * fitting a phone), so it falls back to the select it used to be always.
 */
import { SegmentedControl } from "@/react/rac/segmented-control";
import { SimpleSelect } from "@/react/rac/select";
import { cn } from "@/react/lib/utils";

const MAX_SEGMENTS = 5;

export function ClassPicker({
  classes,
  value,
  onChange,
  className,
}: {
  classes: string[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const options = classes.map((c) => ({ value: c, label: c }));
  return classes.length <= MAX_SEGMENTS ? (
    <SegmentedControl
      ariaLabel="Pilot class"
      value={value}
      onChange={onChange}
      options={options}
      // Full width on a phone; on a wider screen each segment is sized by
      // its label rather than stretched across the page.
      // (`flex-none` with it: a flex-1 segment in a fit-content group shrinks
      // to nothing and truncates its own label.)
      className={cn("sm:w-fit sm:[&>*]:flex-none sm:[&>*]:px-5", className)}
    />
  ) : (
    <SimpleSelect
      ariaLabel="Pilot class"
      value={value}
      onChange={onChange}
      options={options}
      className={className}
    />
  );
}
