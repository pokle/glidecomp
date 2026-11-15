/**
 * The prototype's reading pages (/proto): a competition, its scores, a task,
 * a report card, and the competition's settings. Each has the same bar: back
 * to the page above, the title over the where-am-I menu, and ⋯ for its
 * actions.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { Card } from "@/react/rac/card";
import { ChoiceList } from "@/react/rac/choice-list";
import { TextField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton } from "@/react/rac/form";
import { NavActionRow, NavList } from "@/react/rac/nav-list";
import { Spinner } from "@/react/rac/progress";
import { SwitchField } from "@/react/rac/switch";
import { Tab, TabList, TabPanel, Tabs } from "@/react/rac/tabs";
import { useConfirm } from "../lib/confirm";
import { useLeave } from "../lib/leave";
import { toast } from "../lib/toast";
import {
  COMP,
  COMPS,
  COMP_PAGES,
  P,
  PILOTS,
  RESULTS,
  SCORES,
  TASKS,
  accepted,
} from "./fixtures";
import { useProtoOptions } from "./options";
import {
  PageBar,
  ProtoPage,
  commitClass,
  tabClass,
  tabsClass,
  type Crumb,
  type Related,
} from "./PageBar";
import { Missing } from "./ProtoIndex";
import { Block, LinkRows, stub } from "./parts";

const COMPETITIONS: Crumb = { label: "Competitions", to: `${P}/comp` };
const THIS_COMP: Crumb = { label: COMP.name, to: COMP.path };

/**
 * The pages under the competition: beside the one that is open (ticked), or
 * under the competition's own page when no `current` is given.
 */
export function compPages(current?: string): Related {
  return {
    as: current ? "siblings" : "children",
    items: COMP_PAGES.map((p) => ({ ...p, current: p.label === current })),
  };
}

export function CompHub() {
  const { compId } = useParams();
  const comp = COMPS.find((c) => c.id === compId);
  if (!comp) return <Missing />;
  const filled = comp.id === "corryong";
  return (
    <ProtoPage
      bar={
        <PageBar
          title={comp.name}
          trail={[COMPETITIONS]}
          related={filled ? compPages() : undefined}
          actions={[
            { id: "submit", label: "Submit your track", to: `${P}/submit` },
            {
              id: "record",
              label: "Download the results record (PDF)",
              group: true,
              onAction: stub("Results record"),
            },
            { id: "task", label: "New task", admin: true, group: true, onAction: stub("New task") },
            {
              id: "copy",
              label: "Copy to a new competition…",
              admin: true,
              onAction: stub("Copy to a new competition"),
            },
            { id: "settings", label: "Settings", admin: true, to: `${COMP.path}/settings` },
          ]}
        />
      }
    >
      <p className="px-1 text-muted-foreground">
        {comp.meta} · {comp.dates}
      </p>
      {filled ? (
        <>
          <Block title="This competition">
            <LinkRows
              label="This competition"
              rows={[
                { id: "scores", title: "Scores", value: "Jon Durand leads", to: `${COMP.path}/scores` },
                { id: "pilots", title: "Pilots", value: String(PILOTS.length), to: `${COMP.path}/pilots` },
              ]}
            />
          </Block>
          <Block title="Tasks">
            <LinkRows
              label="Tasks"
              rows={TASKS.map((t) => ({
                id: t.id,
                title: t.name,
                detail: t.day,
                to: `${COMP.path}/task/${t.id}`,
              }))}
            />
          </Block>
        </>
      ) : (
        <Card>
          <p className="font-medium">A long name in the bar</p>
          <p className="text-muted-foreground">
            The title is one line and is cut short when it has to be. Tap it: the menu prints the
            name in full. Only Corryong Cup 2026 is filled in for this prototype.
          </p>
        </Card>
      )}
    </ProtoPage>
  );
}

export function Scores() {
  const [busy, setBusy] = useState(false);
  const rows = (cls: keyof typeof SCORES) =>
    SCORES[cls].map((s, i) => ({
      id: s.id,
      title: `${i + 1}. ${s.name}`,
      value: s.total,
      to: `${COMP.path}/task/3/pilot/${s.id}`,
    }));
  return (
    <Tabs defaultSelectedKey="open" className="gap-0">
      <ProtoPage
        bar={
          <PageBar
            title="Scores"
            trail={[COMPETITIONS, THIS_COMP]}
            related={compPages("Scores")}
            status={busy ? <Spinner label="Recomputing scores" /> : undefined}
            actions={[
              { id: "csv", label: "CSV spreadsheet", onAction: stub("CSV") },
              { id: "sheets", label: "Open in Google Sheets…", onAction: stub("Google Sheets") },
              { id: "pdf", label: "Results record (PDF)", onAction: stub("Results record") },
              { id: "zip", label: "Results data (ZIP)", onAction: stub("Results data") },
              {
                id: "recompute",
                label: "Recompute scores",
                admin: true,
                group: true,
                onAction: () => {
                  setBusy(true);
                  setTimeout(() => {
                    setBusy(false);
                    toast.success("Scores recomputed");
                  }, 2500);
                },
              },
            ]}
            below={
              <TabList aria-label="Class" className={tabsClass}>
                <Tab id="open" className={tabClass}>
                  open
                </Tab>
                <Tab id="floater" className={tabClass}>
                  floater
                </Tab>
              </TabList>
            }
          />
        }
      >
        <p className="px-1 text-sm text-muted-foreground">
          Scores computed 15 Nov 2026, 10:30 AEDT. Each row opens that pilot's report card.
        </p>
        <TabPanel id="open">
          <LinkRows label="Open class scores" rows={rows("open")} />
        </TabPanel>
        <TabPanel id="floater">
          <LinkRows label="Floater class scores" rows={rows("floater")} />
        </TabPanel>
      </ProtoPage>
    </Tabs>
  );
}

function useTask() {
  const { taskId } = useParams();
  const task = TASKS.find((t) => t.id === taskId);
  return task ? { ...task, path: `${COMP.path}/task/${task.id}` } : null;
}

export function Task() {
  const task = useTask();
  if (!task) return <Missing />;
  return (
    <ProtoPage
      bar={
        <PageBar
          title={task.name}
          trail={[COMPETITIONS, THIS_COMP]}
          related={{
            as: "siblings",
            items: TASKS.map((t) => ({
              label: t.name,
              to: `${COMP.path}/task/${t.id}`,
              current: t.id === task.id,
            })),
          }}
          actions={[
            // First, for the pilot who came to do exactly this; and in ⋯, with
            // every other action, so the page itself is the task and its results.
            { id: "submit", label: "Submit your track", to: `${P}/submit` },
            { id: "share", label: "Share task", group: true, onAction: stub("Share task") },
            { id: "qr", label: "QR code", onAction: stub("QR code") },
            { id: "map", label: "View on map", onAction: stub("View on map") },
            { id: "replay", label: "3D replay", onAction: stub("3D replay") },
            { id: "analysis", label: "Task analysis", onAction: stub("Task analysis") },
            { id: "route", label: "Edit route", admin: true, group: true, to: `${task.path}/route` },
            { id: "settings", label: "Task settings", admin: true, onAction: stub("Task settings") },
            { id: "igc", label: "Create a test IGC", admin: true, onAction: stub("Create a test IGC") },
          ]}
        />
      }
    >
      <p className="px-1 text-muted-foreground">{task.day} · open · race to goal</p>
      <Block title="Route">
        <Card className="gap-1">
          <p className="font-medium">ELLIOT → KANGCK → BIGARA → TOOMA → LIGHTH → DWYERS → KHANCO</p>
          <p className="text-sm text-muted-foreground">
            80.2 km · two start gates from 14:00 · deadline 23:00
          </p>
        </Card>
      </Block>
      <Block title="Results">
        <LinkRows
          label="Results"
          rows={RESULTS.map((r, i) => ({
            id: r.id,
            title: `${i + 1}. ${r.name}`,
            detail: r.detail,
            value: r.points,
            to: `${task.path}/pilot/${r.id}`,
          }))}
        />
      </Block>
    </ProtoPage>
  );
}

const SECTIONS = [
  ["The flight", "Took off at 13:42, started at the 14:00 gate and reached goal at 15:52:17."],
  ["Distance points", "Flew the whole 80.2 km of the task, so took every distance point on offer."],
  ["Time points", "Fastest through the speed section at 1:52:17, which sets the time points for the day."],
  ["Leading points", "Led for most of the second and fourth legs."],
  ["Day quality", "Launch, distance and time validity were all 1.000, so the day was worth 1,000 points."],
  ["Track data", "The barometer and the GPS agreed throughout. Nothing was repaired."],
] as const;

export function ReportCard() {
  const task = useTask();
  const { pilotId } = useParams();
  const result = RESULTS.find((r) => r.id === pilotId);
  if (!task || !result) return <Missing />;
  return (
    <ProtoPage
      bar={
        <PageBar
          title={result.name}
          trail={[COMPETITIONS, THIS_COMP, { label: task.name, to: task.path }]}
          related={{
            as: "siblings",
            items: RESULTS.map((r) => ({
              label: r.name,
              to: `${task.path}/pilot/${r.id}`,
              current: r.id === result.id,
            })),
          }}
          actions={[
            { id: "track", label: "Open the track on the map", onAction: stub("Track on the map") },
            { id: "replay", label: "3D replay", onAction: stub("3D replay") },
            {
              id: "manual",
              label: "Record a manual flight",
              admin: true,
              group: true,
              onAction: stub("Manual flight"),
            },
          ]}
        />
      }
    >
      <div className="px-1">
        <p className="text-lg font-semibold">
          {result.detail} — {result.points} points
        </p>
        <p className="text-muted-foreground">
          {COMP.name} · {task.name} · {task.day}
        </p>
      </div>
      {SECTIONS.map(([title, body]) => (
        <Card key={title} className="gap-2">
          <h2 className="text-lg font-bold">{title}</h2>
          <p>{body}</p>
          <p className="text-muted-foreground">
            Scroll on: the bar stays, and the page fades out under it. Three levels deep, the trail
            is one menu under the title rather than two lines of links.
          </p>
        </Card>
      ))}
    </ProtoPage>
  );
}

const GROUPS: Record<string, { label: string; value: string }> = {
  general: { label: "General", value: COMP.name },
  access: { label: "Access", value: "Open registration" },
  scoring: { label: "Scoring", value: "GAP" },
};

export function CompSettings() {
  const confirm = useConfirm();
  const leave = useLeave();
  return (
    <ProtoPage
      bar={
        <PageBar title="Settings" trail={[COMPETITIONS, THIS_COMP]} related={compPages("Settings")} />
      }
    >
      <LinkRows
        label="Settings"
        rows={Object.entries(GROUPS).map(([id, g]) => ({
          id,
          title: g.label,
          value: g.value,
          to: `${COMP.path}/settings/${id}`,
        }))}
      />
      <NavList label="Danger zone">
        <NavActionRow
          label="Delete competition"
          destructive
          onPress={async () => {
            const ok = await confirm({
              title: "Delete this competition?",
              message: "All its tasks and tracks will be deleted. This cannot be undone.",
              confirmLabel: "Delete",
              destructive: true,
            });
            if (!ok) return;
            toast.success(`Deleted ${COMP.name} (not really)`);
            leave(`${P}/comp`);
          }}
        />
      </NavList>
    </ProtoPage>
  );
}

/** One settings group: a form that saves to the server. */
export function CompSettingsForm() {
  const { group = "" } = useParams();
  const confirm = useConfirm();
  const leave = useLeave();
  const [name, setName] = useState(COMP.name);
  const [notes, setNotes] = useState("");
  const [open, setOpen] = useState(true);
  const [format, setFormat] = useState("gap");
  const info = GROUPS[group];
  if (!info) return <Missing />;
  const back = `${COMP.path}/settings`;
  const dirty = name !== COMP.name || notes !== "" || !open || format !== "gap";
  return (
    <Form
      validate={() => ({ name: name.trim() ? null : "Enter a name." })}
      onSubmit={() => accepted()}
      onSuccess={() => {
        toast.success(`Saved ${info.label.toLowerCase()} settings`);
        leave(back);
      }}
    >
      <ProtoPage
        bar={
          <PageBar
            title={info.label}
            fullTitle={`${info.label} settings`}
            trail={[COMPETITIONS, THIS_COMP, { label: "Settings", to: back }]}
            cancel={async () => {
              if (
                dirty &&
                !(await confirm({
                  title: "Discard changes?",
                  message: "Your changes to these settings will be lost.",
                  confirmLabel: "Discard",
                  cancelLabel: "Keep editing",
                  destructive: true,
                }))
              )
                return;
              leave(back);
            }}
            commit={
              <SubmitButton className={commitClass} isDisabled={!dirty}>
                Save
              </SubmitButton>
            }
          />
        }
      >
        <FormErrorBanner />
        {group === "general" ? (
          <>
            <TextField label="Name" name="name" value={name} onChange={setName} />
            <TextField
              label="Notes for every pilot"
              description="Shown on the competition page."
              name="notes"
              placeholder="e.g. Briefing 9:30 at the launch shelter."
              value={notes}
              onChange={setNotes}
            />
          </>
        ) : null}
        {group === "access" ? (
          <SwitchField
            checked={open}
            onChange={setOpen}
            label="Open registration"
            hint="Any signed-in pilot joins the roster the first time they submit a track."
          />
        ) : null}
        {group === "scoring" ? (
          <ChoiceList
            label="Scoring format"
            value={format}
            onChange={setFormat}
            options={[
              { value: "gap", label: "GAP — race to goal" },
              { value: "open", label: "Open distance — fly as far as possible" },
            ]}
          />
        ) : null}
        <p className="text-sm text-muted-foreground">
          Save is greyed out until something changes. Cancel asks before it throws a change away.
        </p>
      </ProtoPage>
    </Form>
  );
}
