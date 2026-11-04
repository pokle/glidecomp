/**
 * One waypoint of the comp's waypoint file (/comp/:compId/waypoints/:n) —
 * every field it has, on a page of its own. ADMIN-ONLY and NOT SSR'd
 * (functions/comp/[[path]].ts serves it a noindex shell).
 *
 * It was a full-screen sheet over the list until #811, and is a page for the
 * reason every overlay became one (the overlays rule in CLAUDE.md): Back,
 * scroll, the keyboard and focus come from the browser.
 *
 * `:n` is the editor's row id (comp/waypoints-draft.ts), not the code — the
 * code is one of the fields edited here, and a waypoint added a minute ago
 * exists only in the draft.
 *
 * **Every change goes straight into the draft**, so Done and Back both keep
 * it, and so does a reload; nothing is saved until Save on the list. (The
 * sheet held a draft of its own and applied it on the way out, because the
 * page behind it repainted its map on every change. This page has no map, and
 * a page's way out is the browser's Back, which a draft held here would lose.)
 * Done checks the coordinates first — it is a kit form — and returns to the
 * list, at the scroll it was left at.
 *
 * Metric throughout: this is the waypoint FILE edited in place, so altitude
 * and radius are both the file's own metres and the labels say so (see the
 * altitude rule in CLAUDE.md).
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { Trash2Icon } from "lucide-react";
import { NotFound } from "@/react/components/NotFound";
import { SectionHeader } from "../components/SectionHeader";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button } from "@/react/rac/button";
import { NumberField, TextField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton } from "@/react/rac/form";
import { underCompWaypoints } from "../lib/crumbs";
import { compWaypointPath, compWaypointsPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { CoordsField, coordsProblem } from "../comp/fields";
import { RADIUS_PRESETS, radiusChipLabel } from "../comp/turnpoint-draft";
import { useWaypointsEditor } from "../comp/use-waypoints-editor";
import { waypointsEditorGate } from "../comp/WaypointsEditorGate";
import { deleteRow, updateRow, type WpFields, type WpRow } from "../comp/waypoints-draft";

export function CompWaypointPage() {
  const editor = useWaypointsEditor();
  const { rowId: rowParam } = useParams<{ rowId: string }>();
  const id = Number(rowParam);
  const { urlId, compName } = editor;
  // Removed on its way out: the page stays as it was until it has gone,
  // rather than flash "not found" for the row it has just removed.
  const [leaving, setLeaving] = useState<WpRow | null>(null);

  const found = editor.draft.rows.find((r) => r.id === id) ?? null;
  const row = found ?? leaving;
  useCanonicalPath(row && compName ? compWaypointPath(urlId, compName, id) : null);

  const gate = waypointsEditorGate(editor);
  if (gate) return gate;
  // A row removed since the link was made, or never in this file.
  if (!row) return <NotFound title="Waypoint not found" />;

  const listPath = compWaypointsPath(urlId, compName);
  const back = () => editor.leave(listPath);
  const set = (patch: Partial<WpFields>) => editor.update((d) => updateRow(d, id, patch));

  const altNumber = Number(row.altitude);
  const radiusNumber = Number(row.radius);

  return (
    <div className="max-w-2xl">
      <Breadcrumbs items={underCompWaypoints(urlId, compName)} current={row.code || "Waypoint"} />
      <Form
        validate={() => ({ coords: coordsProblem(row.coords, true) })}
        // Nothing to send: every change is in the draft already.
        onSuccess={back}
      >
        {/* Done where the sheet had it, top right: in reach without scrolling
            past the whole form. */}
        <SectionHeader
          as="h1"
          className="mt-2"
          title={row.code || "Waypoint"}
          action={<SubmitButton>Done</SubmitButton>}
        />
        <FormErrorBanner className="mt-3" />
        <div className="mt-4 flex flex-col gap-4">
          <TextField
            label="Code"
            name="code"
            value={row.code}
            onChange={(code) => set({ code })}
            description="The short name a pilot's instrument shows, and how a route names this point."
          />
          <TextField
            label="Name"
            name="name"
            value={row.name}
            onChange={(name) => set({ name })}
            description="Optional. The longer description."
          />
          {/* No "show on the map" button here: the list row this page opens
              from has a pin that does it, and one waypoint does not need two
              ways to be looked at. */}
          <CoordsField
            value={row.coords}
            onChange={(coords) => set({ coords })}
            required
            className="font-mono"
          />
          {/* Metres, stated — the file's own unit, not the reader's. */}
          <NumberField
            label="Altitude (m)"
            name="altitude"
            value={row.altitude.trim() === "" || !Number.isFinite(altNumber) ? Number.NaN : altNumber}
            onChange={(v) => set({ altitude: Number.isNaN(v) ? "" : String(Math.round(v)) })}
            formatOptions={{ maximumFractionDigits: 0, useGrouping: false }}
            description="Leave it empty if the altitude is unknown. Zero means sea level."
          />
          <div>
            <NumberField
              label="Radius (m)"
              name="radius"
              value={Number.isFinite(radiusNumber) ? radiusNumber : Number.NaN}
              onChange={(v) => set({ radius: Number.isNaN(v) ? "" : String(Math.round(v)) })}
              formatOptions={{ maximumFractionDigits: 0, useGrouping: false }}
            />
            {/* The same chips the turnpoint editor offers, and the same
                reason: these are the radii an organiser actually sets. */}
            <div className="mt-2 flex flex-wrap gap-2">
              {RADIUS_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  variant="outline"
                  size="sm"
                  onPress={() => set({ radius: String(preset) })}
                >
                  {radiusChipLabel(preset)}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-8 border-t border-border pt-4">
          <Button
            variant="destructive"
            onPress={() => {
              setLeaving(row);
              editor.update((d) => deleteRow(d, id));
              back();
            }}
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
            Remove this waypoint
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Nothing is saved until you press Save on the waypoints page.
          </p>
        </div>
      </Form>
    </div>
  );
}
