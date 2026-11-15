/**
 * The prototype's draft pages (/proto): a route edited as a set, over several
 * pages. Save is on the list page, and is live only while the draft differs
 * from what is saved. A turnpoint's page changes the draft and nothing else.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/react/rac/button";
import { NumberField, TextField } from "@/react/rac/field";
import { useConfirm } from "../lib/confirm";
import { useLeave } from "../lib/leave";
import { toast } from "../lib/toast";
import { formatCylinderRadius } from "../lib/units";
import { COMP, P, TASKS, later } from "./fixtures";
import { PageBar, ProtoPage, commitClass, type Crumb } from "./PageBar";
import { Missing } from "./ProtoIndex";
import { Block, LinkRows, stub } from "./parts";
import {
  discardRoute,
  removeTurnpoint,
  saveRoute,
  setRadius,
  useRouteDraft,
} from "./route-store";

function useTaskTrail(): { trail: Crumb[]; path: string } | null {
  const { taskId } = useParams();
  const task = TASKS.find((t) => t.id === taskId);
  if (!task) return null;
  const path = `${COMP.path}/task/${task.id}`;
  return {
    path,
    trail: [
      { label: "Competitions", to: `${P}/comp` },
      { label: COMP.name, to: COMP.path },
      { label: task.name, to: path },
    ],
  };
}

export function RoutePage() {
  const at = useTaskTrail();
  const confirm = useConfirm();
  const { route, dirty } = useRouteDraft();
  const [saving, setSaving] = useState(false);
  if (!at) return <Missing />;
  return (
    <ProtoPage
      bar={
        <PageBar
          title="Route"
          trail={at.trail}
          actions={[
            { id: "quick", label: "Quick entry", onAction: stub("Quick entry") },
            { id: "xcontest", label: "Load from XContest", onAction: stub("Load from XContest") },
            {
              id: "copy",
              label: "Copy a route from another competition…",
              onAction: stub("Copy a route"),
            },
            ...(dirty
              ? [
                  {
                    id: "discard",
                    label: "Discard changes",
                    destructive: true,
                    group: true,
                    onAction: async () => {
                      const ok = await confirm({
                        title: "Discard changes to the route?",
                        confirmLabel: "Discard",
                        cancelLabel: "Keep editing",
                        destructive: true,
                      });
                      if (ok) discardRoute();
                    },
                  },
                ]
              : []),
          ]}
          commit={
            <Button
              className={commitClass}
              isDisabled={!dirty}
              isPending={saving}
              pendingLabel="Saving"
              onPress={async () => {
                setSaving(true);
                await later(null);
                saveRoute();
                setSaving(false);
                toast.success("Saved the route");
              }}
            >
              Save
            </Button>
          }
        />
      }
    >
      <p className="px-1 text-sm text-muted-foreground" role="status">
        {dirty
          ? "Unsaved changes. Nothing is saved until you press Save."
          : "Open a turnpoint and change its radius: Save, top right, comes alive."}
      </p>
      <LinkRows
        label="Turnpoints"
        rows={route.map((t) => ({
          id: t.id,
          title: t.code,
          detail: [t.role, `r. ${formatCylinderRadius(t.radius).withUnit}`].filter(Boolean).join(" · "),
          value: t.leg,
          to: `${at.path}/route/${t.id}`,
        }))}
      />
      <Button variant="outline" className="h-11 self-start px-5" onPress={stub("Add turnpoint")}>
        Add turnpoint
      </Button>
    </ProtoPage>
  );
}

const PRESETS = [400, 1000, 2000, 3000, 5000];

export function TurnpointPage() {
  const at = useTaskTrail();
  const { turnpointId } = useParams();
  const confirm = useConfirm();
  const leave = useLeave();
  const { route } = useRouteDraft();
  const tp = route.find((t) => t.id === turnpointId);
  if (!at || !tp) return <Missing />;
  const routePath = `${at.path}/route`;
  return (
    <ProtoPage
      bar={
        <PageBar
          title={tp.code}
          fullTitle={`Turnpoint ${tp.id}: ${tp.code}`}
          trail={[...at.trail, { label: "Route", to: routePath }]}
          actions={[
            {
              id: "delete",
              label: "Delete turnpoint",
              destructive: true,
              onAction: async () => {
                const ok = await confirm({
                  title: `Delete ${tp.code} from the route?`,
                  confirmLabel: "Delete",
                  destructive: true,
                });
                if (!ok) return;
                removeTurnpoint(tp.id);
                leave(routePath);
              },
            },
          ]}
          commit={
            <Button className={commitClass} onPress={() => leave(routePath)}>
              Done
            </Button>
          }
        />
      }
    >
      <p className="px-1 text-sm text-muted-foreground">
        A page of a draft. A change here goes into the draft at once; Done and the back arrow both
        return to Route, and nothing is saved until Save there.
      </p>
      <TextField label="Code" name="code" value={tp.code} isReadOnly />
      <Block title="Radius">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((m) => (
            <Button
              key={m}
              variant={tp.radius === m ? "default" : "outline"}
              className="h-11 px-4"
              aria-label={`Set radius ${formatCylinderRadius(m).withUnit}`}
              onPress={() => setRadius(tp.id, m)}
            >
              {formatCylinderRadius(m).withUnit}
            </Button>
          ))}
        </div>
        <NumberField
          aria-label={`Custom radius of ${tp.code} in metres`}
          value={tp.radius}
          minValue={100}
          step={100}
          onChange={(v) => setRadius(tp.id, Number.isFinite(v) ? v : tp.radius)}
        />
      </Block>
      <TextField label="Latitude" name="lat" defaultValue="-36.185833" />
      <TextField label="Longitude" name="lon" defaultValue="147.976669" />
      <p className="text-sm text-muted-foreground">
        Focus a field: the bar is stuck to the top of the page, so the keyboard cannot cover it.
      </p>
    </ProtoPage>
  );
}
