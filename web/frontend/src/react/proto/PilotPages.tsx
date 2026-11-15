/**
 * The prototype's roster pages (/proto): a list with a search, a form that
 * saves to the server, a form that creates, and a page whose name is a whole
 * sentence.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/react/rac/button";
import { SearchField, TextField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton, refusal } from "@/react/rac/form";
import { Radio, RadioGroup } from "@/react/rac/radio-group";
import { useConfirm } from "../lib/confirm";
import { useLeave } from "../lib/leave";
import { toast } from "../lib/toast";
import { COMP, OTHER_COMPS, P, PILOTS, accepted, later, type Pilot } from "./fixtures";
import { compPages } from "./CompPages";
import { useProtoOptions } from "./options";
import { PageBar, ProtoPage, commitClass, searchClass, type Crumb } from "./PageBar";
import { Missing } from "./ProtoIndex";
import { LinkRows, stub } from "./parts";

const TRAIL: Crumb[] = [
  { label: "Competitions", to: `${P}/comp` },
  { label: COMP.name, to: COMP.path },
];
const PILOTS_PATH = `${COMP.path}/pilots`;
const WITH_PILOTS: Crumb[] = [...TRAIL, { label: "Pilots", to: PILOTS_PATH }];

export function Pilots() {
  const { options } = useProtoOptions();
  const [query, setQuery] = useState("");
  const shown = PILOTS.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <ProtoPage
      bar={
        <PageBar
          title="Pilots"
          trail={TRAIL}
          related={compPages("Pilots")}
          add={options.signedIn ? { label: "Add a pilot", to: `${PILOTS_PATH}/new` } : undefined}
          actions={[
            // A name that is a whole sentence has room here, as a menu row.
            {
              id: "copy",
              label: "Copy pilots from another competition…",
              admin: true,
              to: `${PILOTS_PATH}/copy`,
            },
            { id: "civl", label: "Fill from the CIVL ranking…", admin: true, onAction: stub("Fill from CIVL") },
            { id: "import", label: "Import CSV…", admin: true, group: true, onAction: stub("Import CSV") },
            { id: "export", label: "Export CSV", admin: true, onAction: stub("Export CSV") },
          ]}
          below={
            <SearchField
              aria-label="Find a pilot"
              placeholder="Find a pilot"
              variant="floating"
              className={searchClass}
              value={query}
              onChange={setQuery}
            />
          }
        />
      }
    >
      <p className="px-1 text-sm text-muted-foreground">
        {shown.length} of {PILOTS.length} pilots
      </p>
      <LinkRows
        label="Pilots"
        empty="No pilot matches."
        rows={shown.map((p) => ({
          id: p.id,
          title: p.name,
          detail: `${p.pilotClass} · ${p.email || "no email"}`,
          to: `${PILOTS_PATH}/${p.id}`,
        }))}
      />
    </ProtoPage>
  );
}

/** The fields a pilot has, for both the editor and New pilot. */
function PilotFields({
  value,
  set,
}: {
  value: Pilot;
  set: <K extends keyof Pilot>(key: K) => (v: Pilot[K]) => void;
}) {
  return (
    <>
      <TextField label="Name" name="name" value={value.name} onChange={set("name")} />
      <RadioGroup
        label="Class"
        name="pilotClass"
        value={value.pilotClass}
        onChange={(v) => set("pilotClass")(v as Pilot["pilotClass"])}
        orientation="horizontal"
      >
        <div className="flex gap-6">
          <Radio value="open" className="min-h-11 text-base">
            open
          </Radio>
          <Radio value="floater" className="min-h-11 text-base">
            floater
          </Radio>
        </div>
      </RadioGroup>
      <TextField
        label="Glider"
        description="Make, model and colours, so they can be picked out in the air."
        name="glider"
        value={value.glider}
        onChange={set("glider")}
      />
      <TextField label="Team" name="team" value={value.team} onChange={set("team")} />
      {/* Filler, so that Email is off screen when Save is pressed at the top. */}
      {["CIVL ID", "SAFA ID", "USHPA ID", "BHPA ID", "DHV ID", "FFVL ID"].map((label) => (
        <TextField key={label} label={label} name={label} inputMode="numeric" />
      ))}
      <TextField
        label="Email"
        description={'Try an address with "taken" in it: the server refuses it, and the error lands here.'}
        name="email"
        type="email"
        inputMode="email"
        value={value.email}
        onChange={set("email")}
      />
    </>
  );
}

function usePilotDraft(initial: Pilot) {
  const [baseline, setBaseline] = useState(initial);
  const [value, setValue] = useState(initial);
  const set =
    <K extends keyof Pilot>(key: K) =>
    (v: Pilot[K]) =>
      setValue((prev) => ({ ...prev, [key]: v }));
  const dirty = JSON.stringify(value) !== JSON.stringify(baseline);
  return { value, set, dirty, keep: () => setBaseline(value) };
}

/** What the "server" says to a pilot being saved. */
async function savePilot(pilot: Pilot) {
  if (pilot.email.includes("taken"))
    return later(
      refusal("That email is already on another pilot in this competition.", { field: "email" })
    );
  return accepted();
}

function useDiscard(dirty: boolean, back: string) {
  const confirm = useConfirm();
  const leave = useLeave();
  return async () => {
    if (
      dirty &&
      !(await confirm({
        title: "Discard changes?",
        message: "Your changes to this pilot will be lost.",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        destructive: true,
      }))
    )
      return;
    leave(back);
  };
}

export function EditPilot() {
  const { pilotId } = useParams();
  const pilot = PILOTS.find((p) => p.id === pilotId);
  if (!pilot) return <Missing />;
  return <EditPilotForm key={pilot.id} pilot={pilot} />;
}

function EditPilotForm({ pilot }: { pilot: Pilot }) {
  const confirm = useConfirm();
  const leave = useLeave();
  const { value, set, dirty, keep } = usePilotDraft(pilot);
  const discard = useDiscard(dirty, PILOTS_PATH);
  return (
    <Form
      validate={() => ({ name: value.name.trim() ? null : "Enter a name." })}
      onSubmit={() => savePilot(value)}
      onSuccess={() => {
        keep();
        toast.success(`Saved ${value.name}`);
        leave(PILOTS_PATH);
      }}
    >
      <ProtoPage
        bar={
          <PageBar
            title={pilot.name}
            trail={WITH_PILOTS}
            cancel={discard}
            commit={
              <SubmitButton className={commitClass} isDisabled={!dirty}>
                Save
              </SubmitButton>
            }
          />
        }
      >
        <FormErrorBanner />
        <PilotFields value={value} set={set} />
        {/* The one destructive action stays at the foot of the form, as iOS
            keeps "Delete Contact": away from Save, and behind a question. */}
        <Button
          variant="destructive"
          className="mt-4 h-11 self-start px-5"
          onPress={async () => {
            const ok = await confirm({
              title: `Remove ${pilot.name}?`,
              message: "Their tracks stay; their place on the roster goes.",
              confirmLabel: "Remove",
              destructive: true,
            });
            if (!ok) return;
            toast.success(`Removed ${pilot.name} (not really)`);
            leave(PILOTS_PATH);
          }}
        >
          Remove this pilot
        </Button>
      </ProtoPage>
    </Form>
  );
}

const BLANK: Pilot = { id: "new", name: "", pilotClass: "open", email: "", glider: "", team: "" };

export function NewPilot() {
  const leave = useLeave();
  const { value, set, dirty, keep } = usePilotDraft(BLANK);
  const discard = useDiscard(dirty, PILOTS_PATH);
  return (
    <Form
      onSubmit={() => savePilot(value)}
      onSuccess={() => {
        keep();
        toast.success(`Added ${value.name}`);
        leave(PILOTS_PATH);
      }}
    >
      <ProtoPage
        bar={
          <PageBar
            title="New pilot"
            trail={WITH_PILOTS}
            cancel={discard}
            commit={
              <SubmitButton className={commitClass} pendingLabel="Adding" isDisabled={!value.name.trim()}>
                Add
              </SubmitButton>
            }
          />
        }
      >
        <FormErrorBanner />
        <PilotFields value={value} set={set} />
      </ProtoPage>
    </Form>
  );
}

/**
 * A page whose name is a sentence. The sentence is the ⋯ row that opened it
 * and the line at the top of the page; the bar says "Copy pilots".
 */
export function CopyPilots() {
  const confirm = useConfirm();
  const leave = useLeave();
  const [query, setQuery] = useState("");
  const shown = OTHER_COMPS.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <ProtoPage
      bar={
        <PageBar
          title="Copy pilots"
          fullTitle="Copy pilots from another competition"
          trail={WITH_PILOTS}
          cancel={() => leave(PILOTS_PATH)}
          below={
            <SearchField
              aria-label="Search competitions"
              placeholder="Search by competition name"
              variant="floating"
              className={searchClass}
              value={query}
              onChange={setQuery}
            />
          }
        />
      }
    >
      <p className="px-1">
        Choose a competition. Its pilots are added to {COMP.name}; pilots already here are left as
        they are.
      </p>
      <div className="flex flex-col gap-2">
        {shown.map((c) => (
          <Button
            key={c.id}
            variant="outline"
            className="h-auto min-h-14 justify-between gap-3 px-4 py-2 text-left whitespace-normal"
            onPress={async () => {
              const ok = await confirm({
                title: `Copy the pilots from ${c.name}?`,
                message: c.detail,
                confirmLabel: "Copy pilots",
              });
              if (!ok) return;
              toast.success(`Copied the pilots from ${c.name} (not really)`);
              leave(PILOTS_PATH);
            }}
          >
            <span className="min-w-0">
              <span className="block text-base font-medium">{c.name}</span>
              <span className="block text-sm font-normal text-muted-foreground">{c.detail}</span>
            </span>
          </Button>
        ))}
        {shown.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">No competition matches.</p>
        ) : null}
      </div>
    </ProtoPage>
  );
}
