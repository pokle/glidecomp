/**
 * TabulatorGrid — this project's React wrapper around Tabulator.
 *
 * Editable tables are Tabulator by policy (see the Tabulator policy in
 * docs/2026-07-18-rac-adoption-guide.md), so this is the one place that knows
 * how to get a Tabulator instance onto the page: grids declare
 * `columns`/`data`/`options`/`events` and nobody hand-rolls the lazy
 * import → build → bind → destroy lifecycle again.
 *
 * Deliberately **not** the `react-tabulator` package that tabulator.info's
 * React docs point at: it hard-depends on `tabulator-tables@5.6.1` (we're on
 * 6.x, so it would ship a second, older copy of Tabulator) and peers at
 * React <= 17 (we're on 19). This follows the prop shape that package
 * documents — columns / data / options / events, plus access to the instance —
 * with three deliberate differences:
 *
 *  1. **Lazy.** The library and its CSS load via dynamic `import()` inside an
 *     effect, so Tabulator stays out of the SSR bundle (these grids sit on
 *     server-rendered pages, and Tabulator touches `window` at module scope)
 *     and out of the chunk every visitor downloads — the grids are admin-only.
 *     The instance therefore only exists a tick or two after mount: wait for
 *     `onReady` rather than assuming a grid on first render. On the server (and
 *     until the chunk lands) this renders an empty container div.
 *  2. **Uncontrolled.** `columns` and `data` are read once, when the grid is
 *     built — Tabulator owns its rows from then on, which is the whole reason
 *     we keep it for editable tables. Push later changes through the instance
 *     (`setData`, `addRow`, `updateData`, …) and remount via React's `key` to
 *     rebuild from scratch. (react-tabulator instead re-runs its constructor
 *     whenever the `data` prop changes, without destroying the previous
 *     instance — which both leaks and loses scroll/edit state.)
 *  3. **Handlers can't go stale.** `events` handlers are dispatched through a
 *     ref, so a handler closing over current state keeps working without
 *     rebuilding the grid. The set of event *names* is read once at build time,
 *     so keep the keys of `events` stable across renders.
 */
import { useEffect, useRef, type RefObject } from "react";
import type {
  ColumnDefinition,
  EventCallBackMethods,
  Options,
  Tabulator,
} from "tabulator-tables";

/**
 * `{ eventName: handler }`, typed against Tabulator's own event map — so
 * handler arguments are checked per event name rather than being `any`.
 */
export type TabulatorGridEvents = {
  [K in keyof EventCallBackMethods]?: EventCallBackMethods[K];
};

export interface TabulatorGridProps {
  /** Column definitions. Read once, when the grid is built (see the header). */
  columns: ColumnDefinition[];
  /** Initial rows. Read once, when the grid is built (see the header). */
  data?: unknown[];
  /**
   * Everything else Tabulator takes, merged last so it wins over the defaults
   * this wrapper sets. `columns`/`data` are their own props.
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
  columns,
  data,
  options,
  events,
  tableRef,
  onReady,
  className,
  id,
}: TabulatorGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Build inputs and callbacks are read through refs rather than closed over:
  // the grid is built once per mount (see the header), and both call sites
  // build their columns inline, so depending on prop identity would tear the
  // grid down on every render.
  const buildRef = useRef({ columns, data, options });
  buildRef.current = { columns, data, options };
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
      table = new TabulatorFull(containerRef.current, {
        // `fitColumns` is the default the react-tabulator docs document; any
        // `options.layout` overrides it.
        layout: "fitColumns",
        ...build.options,
        columns: build.columns,
        ...(build.data ? { data: build.data as Options["data"] } : {}),
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
