/**
 * TabulatorGrid — this project's React wrapper around Tabulator.
 *
 * Editable tables are Tabulator by policy (see the Tabulator policy in
 * docs/2026-07-18-rac-adoption-guide.md), so this is the one place that knows
 * how to get a Tabulator instance onto the page: grids declare their columns,
 * rows, options and events, and nobody hand-rolls the lazy
 * import → build → bind → destroy lifecycle again.
 *
 * Informed by the `react-tabulator` package that tabulator.info's React docs
 * point at, but deliberately not it, and deliberately not its API either. That
 * package hard-depends on `tabulator-tables@5.6.1` (we're on 6.x, so it would
 * ship a second, older copy of Tabulator) and peers at React <= 17 (we're on
 * 19). Where its design would mislead, this diverges:
 *
 *  1. **Lazy.** The library and its CSS load via dynamic `import()` inside an
 *     effect, so Tabulator stays out of the SSR bundle (these grids sit on
 *     server-rendered pages, and Tabulator touches `window` at module scope)
 *     and out of the chunk every visitor downloads — the grids are admin-only.
 *     The instance therefore only exists a tick or two after mount: wait for
 *     `onReady` rather than assuming a grid on first render. On the server (and
 *     until the chunk lands) this renders an empty container div.
 *  2. **Uncontrolled, and typed that way.** Tabulator owns its rows once built
 *     — which is the whole reason we keep it for editable tables — so there is
 *     no reactive `data` prop. `initialColumns`/`initialData` are **functions**
 *     the wrapper calls exactly once, at build: the contract is in the type, a
 *     caller can't accidentally recompute a big row array on every render, and
 *     nobody has to wonder whether assigning to a `data` prop re-syncs the
 *     grid (in `react-tabulator` it re-runs the constructor without destroying
 *     the previous instance, which leaks and discards in-progress edits).
 *     Push later changes through `tableRef` (`setData`, `addRow`,
 *     `updateData`, …) and remount via React's `key` to rebuild from scratch.
 *  3. **Rows are cloned for you.** Tabulator edits its row objects in place,
 *     so `initialData`'s rows are shallow-copied before they're handed over —
 *     a caller can safely return objects straight out of React state. (Rows
 *     are expected to be flat; nested values stay shared.)
 *  4. **Handlers can't go stale.** `events` handlers are dispatched through a
 *     ref, so a handler closing over current state keeps working without the
 *     grid being rebuilt. The set of event *names* is read once at build time,
 *     so keep the keys of `events` stable across renders.
 *  5. **Editors don't autofill.** Every column gets `elementAttributes`
 *     turning off autocomplete/autocapitalize/autocorrect/spellcheck on the
 *     `<input>` Tabulator builds — see EDITOR_ELEMENT_ATTRIBUTES below.
 */
import { useEffect, useRef, type RefObject } from "react";
import type {
  CellComponent,
  ColumnDefinition,
  EditorParams,
  EventCallBackMethods,
  Options,
  Tabulator,
} from "tabulator-tables";

/**
 * Forced onto every editor input Tabulator builds.
 *
 * Tabulator creates those `<input>`s itself, so no JSX can reach them, and
 * left bare Safari classifies them from their surroundings and offers
 * autofill: clicking any cell in the pilots grid popped up the user's saved
 * email addresses over the table (that grid has an email column). A grid cell
 * is never a field to autofill — it's already bound to a data field.
 *
 * `elementAttributes` is Tabulator's supported hook for this: a
 * `SharedEditorParams` honoured by the input/number/textarea/list/… editors,
 * copied onto the editor element with setAttribute.
 */
const EDITOR_ELEMENT_ATTRIBUTES = {
  autocomplete: "off",
  autocapitalize: "none",
  autocorrect: "off",
  spellcheck: "false",
} as const;

/**
 * Merge the forced attributes into one column's editorParams, which Tabulator
 * lets a column supply either as an object or as a per-cell function.
 */
function withEditorAttributes(params: EditorParams | undefined): EditorParams {
  if (typeof params === "function") {
    return (cell: CellComponent) => mergeAttributes(params(cell));
  }
  return mergeAttributes(params) as EditorParams;
}

/** Caller-supplied attributes win, so a column can still opt back in. */
function mergeAttributes(params: object | undefined): Record<string, unknown> {
  const existing = (params as { elementAttributes?: Record<string, unknown> } | undefined)
    ?.elementAttributes;
  return { ...params, elementAttributes: { ...EDITOR_ELEMENT_ATTRIBUTES, ...existing } };
}

/**
 * Apply the editor attributes across a column tree (recursing through column
 * groups). Columns without an editor get them too — the attributes are simply
 * never read there, and that covers editors set via `columnDefaults`.
 */
function hardenColumns(columns: ColumnDefinition[]): ColumnDefinition[] {
  return columns.map((column) => ({
    ...column,
    ...(column.columns ? { columns: hardenColumns(column.columns) } : {}),
    editorParams: withEditorAttributes(column.editorParams),
  }));
}

/**
 * `{ eventName: handler }`, typed against Tabulator's own event map — so
 * handler arguments are checked per event name rather than being `any`.
 */
export type TabulatorGridEvents = {
  [K in keyof EventCallBackMethods]?: EventCallBackMethods[K];
};

export interface TabulatorGridProps {
  /** Column definitions. Called once, when the grid is built. */
  initialColumns: () => ColumnDefinition[];
  /**
   * The rows to build with. Called once, when the grid is built, and the rows
   * it returns are shallow-copied — so returning React state directly is safe.
   */
  initialData?: () => unknown[];
  /**
   * Everything else Tabulator takes, merged last so it wins over the defaults
   * this wrapper sets. Columns and rows have their own props.
   */
  options?: Omit<Options, "columns" | "data">;
  /** Tabulator events to bind, e.g. `{ cellEdited: … , rowDeleted: … }`. */
  events?: TabulatorGridEvents;
  /**
   * Populated with the instance once the grid is built and cleared when it is
   * destroyed — the handle for the imperative calls (`getData`, `addRow`,
   * `setData`, `setFilter`, …) that a grid-owns-its-data table needs.
   */
  tableRef?: RefObject<Tabulator | null>;
  /**
   * Called once the grid is built and usable: enable the buttons that drive
   * it, apply an initial filter, and so on. Calling Tabulator methods before
   * this fires is not safe.
   */
  onReady?: (table: Tabulator) => void;
  className?: string;
  /** Needed when Tabulator's `popupContainer` must point at an ancestor. */
  id?: string;
}

export function TabulatorGrid({
  initialColumns,
  initialData,
  options,
  events,
  tableRef,
  onReady,
  className,
  id,
}: TabulatorGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Build inputs and callbacks are read through refs rather than closed over:
  // the grid is built once per mount, so depending on prop identity would tear
  // it down on every render (every call site builds its columns inline).
  const buildRef = useRef({ initialColumns, initialData, options });
  buildRef.current = { initialColumns, initialData, options };
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let cancelled = false;
    let table: Tabulator | null = null;
    void (async () => {
      const [{ TabulatorFull }] = await Promise.all([
        import("tabulator-tables"),
        import("tabulator-tables/dist/css/tabulator_simple.min.css"),
        import("./tabulator-grid.css"),
      ]);
      if (cancelled || !containerRef.current) return;
      const build = buildRef.current;
      // Cloned: Tabulator edits row objects in place, and these may be the
      // very objects the caller holds in React state.
      const rows = build.initialData?.().map((row) => ({ ...(row as object) }));
      table = new TabulatorFull(containerRef.current, {
        // `fitColumns` is Tabulator's own documented default for a React
        // wrapper; any `options.layout` overrides it.
        layout: "fitColumns",
        ...build.options,
        columns: hardenColumns(build.initialColumns()),
        ...(rows ? { data: rows as Options["data"] } : {}),
      });

      // Bind a trampoline per event name so the handler is looked up at call
      // time — a handler that closes over state stays current without the
      // grid being rebuilt.
      for (const name of Object.keys(eventsRef.current ?? {})) {
        const event = name as keyof EventCallBackMethods;
        table.on(event, ((...args: unknown[]) => {
          const handler = eventsRef.current?.[event] as
            | ((...a: unknown[]) => void)
            | undefined;
          handler?.(...args);
        }) as EventCallBackMethods[typeof event]);
      }

      // Publish the instance only once Tabulator says it's built: methods
      // called before that aren't safe, and the buttons around a grid are
      // gated on this.
      table.on("tableBuilt", () => {
        if (cancelled || !table) return;
        if (tableRef) tableRef.current = table;
        onReadyRef.current?.(table);
      });
    })();
    return () => {
      cancelled = true;
      table?.destroy();
      if (tableRef) tableRef.current = null;
    };
  }, [tableRef]);

  return <div ref={containerRef} id={id} className={className} />;
}
