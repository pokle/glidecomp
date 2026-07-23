/**
 * "Enter task" — the type-it-out route builder at the top of the route editor
 * (prototype).
 *
 * Type a route the way you'd say it — "ell 400m ell 5k mitta cudg ncor 1k" —
 * and the whole set of turnpoints falls out: names are fuzzy-matched against
 * the competition's waypoints, and a distance after a name is that cylinder's
 * radius (see quick-task.ts for the grammar). While you type, the token under
 * the caret offers its best matches as tappable chips.
 *
 * The line and the route are one thing seen two ways: the text round-trips
 * exactly (see quickTaskText), so the field shows the loaded task as text, and
 * editing the text rebuilds the route — no button, and no preview, because the
 * turnpoint listing right below IS the read-back. The box is a textarea that
 * grows to the whole task; a real competition task doesn't fit one line.
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
  parseQuickTask,
  quickTaskText,
  randomExampleRoute,
  resolveTypes,
  suggestionsFor,
  type QuickType,
} from "./quick-task";

/** One turnpoint the field is ready to hand back to the editor. */
export interface QuickTaskPick {
  record: WaypointFileRecord;
  radius: number;
  type: QuickType;
}

const SUGGESTION_LIMIT = 6;

/** Pause after typing before the route is rebuilt (ms). */
const APPLY_DELAY_MS = 250;

export function QuickTaskField({
  waypoints,
  defaultRadius,
  routeText,
  placeholder = "ell 400m ell 5k mitta cudg ncor 1k",
  exampleSize,
  isDisabled,
  onApply,
}: {
  waypoints: WaypointFileRecord[];
  /** Radius used for turnpoints with no distance token. */
  defaultRadius: number;
  /** The route the editor currently holds, as a quick-task line. */
  routeText: string;
  /** Example line for the empty field — an open-distance task takes one name. */
  placeholder?: string;
  /** Turnpoints in the offered example (open distance allows exactly one). */
  exampleSize?: number;
  isDisabled?: boolean;
  onApply: (picks: QuickTaskPick[]) => void;
}) {
  const [text, setText] = useState(routeText);
  const [caret, setCaret] = useState(routeText.length);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The line and the route are kept in step in both directions. `pristine` is
  // true while the line is simply showing the route (nothing typed since the
  // last agreement) — the state in which the line must never push, because a
  // route can hold things the line can't say (a turnpoint whose name is no
  // competition waypoint), and pushing would quietly drop them. `synced` is
  // the route text both sides last agreed on, which is how a change made
  // elsewhere in the editor is told apart from this field's own push.
  const pristineRef = useRef(true);
  const syncedRef = useRef(routeText);

  const items = useMemo(
    () => parseQuickTask(text, waypoints, { defaultRadius }),
    [text, waypoints, defaultRadius]
  );

  // Suggestions for the token under the caret — the autocomplete half.
  const token = useMemo(() => activeToken(text, caret), [text, caret]);
  const suggestions = useMemo(
    () => (token ? suggestionsFor(token.raw, waypoints, SUGGESTION_LIMIT) : []),
    [token, waypoints]
  );

  const types = resolveTypes(items);

  /** The waypoint each parsed turnpoint resolves to — its best guess. */
  const resolved = items.map((item, i) => ({
    item,
    record: item.candidates[0] ?? null,
    type: types[i] ?? ("" as QuickType),
  }));

  const matched = resolved.filter((r) => r.record !== null);
  const unmatched = resolved.length - matched.length;

  // What the line says the route should be, and the route it would round-trip
  // to. Comparing the two is what tells us whether there's anything to push.
  const picks: QuickTaskPick[] = matched.map((r) => ({
    record: r.record!,
    radius: r.item.radius,
    type: r.type,
  }));
  const route = picks.map((p) => ({
    name: p.record.code,
    radius: p.radius,
    type: p.type,
  }));
  // The shortest text that rebuilds this route — compared against the editor's
  // own rendering of the route to decide whether there's anything to push.
  const builtText = quickTaskText(route);
  // The same route with every role named. What Enter writes: it turns what the
  // line only implied into something on screen you can see and edit.
  const spelledText = quickTaskText(route, { types: "all" });
  const picksRef = useRef(picks);
  picksRef.current = picks;

  /**
   * Set the line as a user edit — which is what makes the route follow it.
   * `keepFocus` puts the caret back after React writes the value; it must be
   * off when the edit is triggered BY focus leaving, or the field would drag
   * focus back and trap it.
   */
  function setLine(
    next: string,
    caretAt = next.length,
    { keepFocus = true }: { keepFocus?: boolean } = {}
  ) {
    pristineRef.current = false;
    setText(next);
    setCaret(caretAt);
    if (!keepFocus) return;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caretAt, caretAt);
    });
  }

  /**
   * Rewrite the line as the route reads back: resolved codes, radii spelled
   * out, and every role named — take-off, start, ESS, goal. What Enter does,
   * and what leaving the field does. A half-typed "mit" becomes MTMITA,
   * because that is already the turnpoint the route was given; an implied SSS
   * becomes a written one, because that's the half of the task that's easiest
   * to get wrong and hardest to see.
   */
  function normalise({ keepFocus = true }: { keepFocus?: boolean } = {}) {
    if (spelledText === "" || spelledText === text) return;
    setLine(spelledText, spelledText.length, { keepFocus });
  }

  /** Put a waypoint code into the token under the caret and keep typing. */
  function accept(code: string) {
    if (!token) return;
    // Restoring the caret is what lets the next keystroke land where the
    // completion left off rather than at the end.
    const next = completeToken(text, token, code);
    setLine(next.text, next.caret);
  }

  // Route → line: adopt anything changed elsewhere in the editor (an import,
  // Add turnpoint, Clear turnpoints). Our own push landing is not a change to
  // adopt — it's the route agreeing with what the line already says.
  const builtTextRef = useRef(builtText);
  builtTextRef.current = builtText;
  useEffect(() => {
    if (routeText === syncedRef.current) return;
    syncedRef.current = routeText;
    if (routeText === builtTextRef.current) return;
    pristineRef.current = true;
    setText(routeText);
    setCaret(routeText.length);
  }, [routeText]);

  // Line → route: editing the line edits the route. The two are views of one
  // thing (the line round-trips exactly), so there's nothing to press.
  // Debounced, so a rebuild lands on a pause rather than on every keystroke.
  useEffect(() => {
    if (pristineRef.current) return;
    if (builtText === routeText) return;
    const timer = setTimeout(() => {
      syncedRef.current = builtText;
      onApply(picksRef.current);
    }, APPLY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [builtText, routeText, onApply]);

  // A worked example built from this competition's waypoints. Regenerated
  // after each use, so the button always offers a route you haven't just
  // taken. Random, so it's created here rather than during any render the
  // server might do (see the SSR notes in CLAUDE.md).
  const [exampleNonce, setExampleNonce] = useState(0);
  const [example, setExample] = useState("");
  useEffect(() => {
    setExample(randomExampleRoute(waypoints, { defaultRadius, size: exampleSize }));
  }, [waypoints, defaultRadius, exampleSize, exampleNonce]);

  /** Take the example: it replaces the route, exactly as typing it would. */
  function useExample() {
    if (!example) return;
    setLine(example);
    setExampleNonce((n) => n + 1);
  }

  /** Track the caret so suggestions follow it when you edit mid-line. */
  function syncCaret() {
    setCaret(inputRef.current?.selectionStart ?? text.length);
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
  }, [text]);

  return (
    <div
      ref={panelRef}
      className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3"
      // Leaving the field tidies the line, exactly as Enter does — so tapping
      // the map or a button never leaves a half-typed "mit" sitting where the
      // route already says MTMITA. Scoped to focus leaving the whole panel:
      // moving to the suggestion strip is still working in the field, and
      // rewriting the text there would pull the token out from under the tap.
      onBlur={(e) => {
        if (panelRef.current?.contains(e.relatedTarget as Node | null)) return;
        normalise({ keepFocus: false });
      }}
    >
      <AriaTextField
        className="flex flex-col gap-1.5"
        value={text}
        onChange={(v) => {
          setText(v);
          pristineRef.current = false;
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
          // the route round-trips to (resolved codes, radii spelled out),
          // keeping focus so refining carries straight on. The route itself
          // needs no keypress: it's already following along.
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
        <Description>Type your waypoint names, and hit enter</Description>
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
          what someone typed (or the route the field is showing). Clearing the
          box brings it back, with a fresh route. */}
      {example && text.trim() === "" ? (
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

      {/* Status, not a preview: the route itself is the read-back — it's
          right below, in the same listing the task page shows. */}
      <p
        aria-live="polite"
        className={unmatched > 0 ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
      >
        {unmatched > 0
          ? `${unmatched} name${unmatched === 1 ? "" : "s"} didn't match a competition waypoint — skipped`
          : items.length > 0
            ? `${matched.length} turnpoint${matched.length === 1 ? "" : "s"} · the route below updates as you type`
            : "The route below updates as you type"}
      </p>
    </div>
  );
}
