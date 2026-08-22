/**
 * "Enter task" — the type-it-out route builder, now the body of the route
 * editor's Quick entry sheet (comp/QuickEntrySheet.tsx).
 *
 * Type a route the way you'd say it — "ell 400m ell 5k mitta cudg ncor 1k" —
 * and the whole set of turnpoints falls out: names are fuzzy-matched against
 * the competition's waypoints, and a distance after a name is that cylinder's
 * radius (see quick-task.ts for the grammar). While you type, the token under
 * the caret offers its best matches as tappable chips.
 *
 * The start settings ride the same line ("mitta sss enter 13:15"), so the
 * direction and the gates are text you can see and edit rather than defaults
 * applied silently in a collapsed panel further down (#436).
 *
 * It used to be a LIVE MIRROR of the route: the field sat above the turnpoint
 * listing, showed the loaded task as text, and pushed every pause in your
 * typing back into the route. That is gone (#661). The line is a lossy view of
 * a route — it cannot say a turnpoint's coordinates, its altitude or its long
 * name — so a mirror that rebuilt the route from the text quietly threw those
 * away, and it did so on a keystroke rather than on a decision. Applying is now
 * an explicit press in the sheet, and it reconciles rather than rebuilds (see
 * route-reconcile.ts). This component is the editor for the text and nothing
 * else: it owns no route, and its value is controlled by the sheet.
 *
 * Mobile first: no overlays at all — suggestions sit inline under the field,
 * where a phone keyboard can't cover them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { TextField as AriaTextField } from "react-aria-components";
import type { WaypointFileRecord } from "@glidecomp/engine";
import { Button } from "@/react/rac/button";
import { Description, Label, TextArea } from "@/react/rac/field";
import { ListBox, ListBoxItem } from "@/react/rac/list-box";
import {
  activeToken,
  completeToken,
  quickTaskApply,
  randomExampleRoute,
  suggestionsFor,
} from "./quick-task";

const SUGGESTION_LIMIT = 6;

export function QuickTaskField({
  waypoints,
  defaultRadius,
  value,
  onChange,
  knownNames,
  placeholder = "ell 400m ell 5k mitta cudg ncor 1k",
  exampleSize,
  timeZoneLabel,
  isDisabled,
}: {
  waypoints: WaypointFileRecord[];
  /** Radius used for turnpoints with no distance token. */
  defaultRadius: number;
  /** The line being edited. Controlled — the sheet owns it. */
  value: string;
  onChange: (text: string) => void;
  /**
   * Names of the turnpoints the route already holds. A token spelling one of
   * them exactly counts as matched even when the competition's waypoints have
   * nothing like it, so the status line agrees with what applying would
   * actually do (see quickTaskApply).
   */
  knownNames?: string[];
  /** Example line for the empty field — an open-distance task takes one name. */
  placeholder?: string;
  /** Turnpoints in the offered example (open distance allows exactly one). */
  exampleSize?: number;
  /**
   * Zone the start gates in the line are read in ("Australia/Melbourne
   * (GMT+11)"). Shown beside the field so "13:15" is never ambiguous; omitted
   * where the line can't carry gates at all (open distance).
   */
  timeZoneLabel?: string;
  isDisabled?: boolean;
}) {
  const [caret, setCaret] = useState(value.length);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Suggestions for the token under the caret — the autocomplete half.
  const token = useMemo(() => activeToken(value, caret), [value, caret]);
  const suggestions = useMemo(
    () => (token ? suggestionsFor(token.raw, waypoints, SUGGESTION_LIMIT) : []),
    [token, waypoints]
  );

  // What the line says, read exactly as applying it would read it.
  const parsed = useMemo(
    () => quickTaskApply(value, waypoints, { defaultRadius, knownNames }),
    [value, waypoints, defaultRadius, knownNames]
  );
  const matched = parsed.picks.length;

  /** Set the line and put the caret back after React writes the value. */
  function setLine(next: string, caretAt = next.length) {
    onChange(next);
    setCaret(caretAt);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caretAt, caretAt);
    });
  }

  /**
   * Rewrite the line as the route reads back: resolved codes and every role
   * named — take-off, start, ESS, goal. What Enter does. Radii are written
   * only where the line already stated one, so tidying never invents a
   * cylinder size. A half-typed "mit" becomes MTMITA,
   * because that is already the turnpoint the line was given; an implied SSS
   * becomes a written one, because that's the half of the task that's easiest
   * to get wrong and hardest to see.
   */
  function normalise() {
    if (parsed.spelledText === "" || parsed.spelledText === value) return;
    setLine(parsed.spelledText, parsed.spelledText.length);
  }

  /** Put a waypoint code into the token under the caret and keep typing. */
  function accept(code: string) {
    if (!token) return;
    // Restoring the caret is what lets the next keystroke land where the
    // completion left off rather than at the end.
    const next = completeToken(value, token, code);
    setLine(next.text, next.caret);
  }

  // A worked example built from this competition's waypoints. Regenerated
  // after each use, so the button always offers a route you haven't just
  // taken. Random, so it's created here rather than during any render the
  // server might do (see the SSR notes in CLAUDE.md).
  const [exampleNonce, setExampleNonce] = useState(0);
  const [example, setExample] = useState("");
  useEffect(() => {
    setExample(randomExampleRoute(waypoints, { defaultRadius, size: exampleSize }));
  }, [waypoints, defaultRadius, exampleSize, exampleNonce]);

  /** Take the example: it fills the line, exactly as typing it would. */
  function useExample() {
    if (!example) return;
    setLine(example);
    setExampleNonce((n) => n + 1);
  }

  /** Track the caret so suggestions follow it when you edit mid-line. */
  function syncCaret() {
    setCaret(inputRef.current?.selectionStart ?? value.length);
  }

  // Grow the box to fit the whole task, up to the CSS max-height (past which
  // it scrolls). Re-measured on every change, including the seeded route and
  // any width change, so a wrapped line never hides behind a scrollbar.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    // scrollHeight is content + padding but not borders, and the box is
    // border-box — without adding them back the last line sits 2px clipped.
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${el.scrollHeight + borders}px`;
  }, [value]);

  return (
    // Leaving the field does NOT tidy the line any more. It did while the
    // field was a live mirror, so that tapping elsewhere couldn't leave a
    // half-typed "mit" where the route already said MTMITA. Now that applying
    // is a press, a blur handler rewrites the text in the instant the reader
    // reaches for the button — changing what they are about to apply after
    // they have decided. Enter still tidies; that is a key they chose to hit,
    // and it shows the result before anything is applied.
    <div className="flex flex-col gap-2">
      <AriaTextField
        className="flex flex-col gap-1.5"
        value={value}
        onChange={(v) => {
          onChange(v);
          // The change event fires before the caret is readable off the DOM in
          // some mobile IMEs; read it on the next frame.
          requestAnimationFrame(syncCaret);
        }}
        onKeyDown={(e) => {
          // Shift+Enter falls through to the textarea as a line break — handy
          // for laying a long task out over a few lines (the parser splits on
          // any whitespace, so newlines change nothing about the route).
          if (e.key !== "Enter" || e.shiftKey) return;
          // Mid-word, Enter takes the top suggestion — the fast path for
          // "keep typing". Otherwise it tidies the line into the exact text
          // the route round-trips to (resolved codes, radii spelled out).
          e.preventDefault();
          if (suggestions.length > 0) accept(suggestions[0].code);
          else normalise();
        }}
        isDisabled={isDisabled}
      >
        <Label>Enter task</Label>
        {/* A textarea, not a single line: a full competition task runs well
            past one input's width, and the whole route has to be readable at
            a glance to be worth correcting. It grows with the text (see
            autoGrow) and can still be dragged taller. */}
        <TextArea
          ref={inputRef}
          rows={2}
          className="max-h-48 min-h-16 leading-relaxed"
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyUp={syncCaret}
        />
        <Description>
          Type your waypoint names, and hit enter
          {timeZoneLabel ? ` · start gate times are ${timeZoneLabel}` : ""}
        </Description>
      </AriaTextField>

      {/* Autocomplete for the token under the caret. A horizontal strip rather
          than a popover: it can't be covered by the on-screen keyboard, and
          left/right arrows walk it for keyboard users. */}
      {suggestions.length > 0 ? (
        <ListBox
          aria-label={`Waypoints matching “${token?.raw ?? ""}”`}
          orientation="horizontal"
          selectionMode="none"
          items={suggestions.map((w) => ({ id: w.code, wp: w }))}
          onAction={(key) => accept(String(key))}
          className="flex snap-x gap-1.5 overflow-x-auto border-0 p-0"
        >
          {({ wp }) => (
            <ListBoxItem
              textValue={wp.code}
              className="w-fit shrink-0 snap-start cursor-pointer rounded-full border border-border bg-background px-2.5 py-1 text-xs"
            >
              <span className="font-medium">{wp.code}</span>
              {wp.name && wp.name !== wp.code ? (
                <span className="text-muted-foreground">{wp.name}</span>
              ) : null}
            </ListBoxItem>
          )}
        </ListBox>
      ) : null}

      {/* One tap to a real route, spelled with this comp's own waypoints — the
          fastest way to see the grammar, and something to edit instead of an
          empty box. Only ever offered when the box IS empty: taking it
          replaces the line, and a stray tap must never be able to throw away
          what someone typed. Clearing the box brings it back, with a fresh
          route. */}
      {example && value.trim() === "" ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-auto w-fit max-w-full justify-start px-1.5 py-1 text-left font-normal whitespace-normal"
          onPress={useExample}
        >
          <span className="text-muted-foreground">Try</span>
          <span className="font-mono text-xs">{example}</span>
        </Button>
      ) : null}

      {/* Status, not a preview. One live region for the count and the start
          problems together, so a screen reader hears one update rather than
          two racing announcements. */}
      <div aria-live="polite" className="flex flex-col gap-1">
        <p
          className={
            parsed.unmatched > 0
              ? "text-xs text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          {parsed.unmatched > 0
            ? `${parsed.unmatched} name${parsed.unmatched === 1 ? "" : "s"} didn't match a competition waypoint — skipped`
            : parsed.itemCount > 0
              ? `${matched} turnpoint${matched === 1 ? "" : "s"}`
              : ""}
        </p>
        {/* Anything the line says about the start that the route can't use.
            Amber, not red: none of these block a save, and the turnpoints are
            still good — it's the start setting that didn't land. */}
        {parsed.problems.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-xs text-amber-500">
            {parsed.problems.map((problem, i) => (
              <li key={i}>⚠ {problem}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
