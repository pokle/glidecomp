/**
 * The prototype's top-level pages (/proto): the three places the app starts
 * from, and the page that starts a competition. A top-level page has no
 * parent, so its leading control is the main menu.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/react/rac/button";
import { Card } from "@/react/rac/card";
import { ChoiceList } from "@/react/rac/choice-list";
import { SearchField, TextField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton } from "@/react/rac/form";
import { Tab, TabList, TabPanel, Tabs } from "@/react/rac/tabs";
import { useConfirm } from "../lib/confirm";
import { useLeave } from "../lib/leave";
import { toast } from "../lib/toast";
import { COMPS, P, TASKS, accepted } from "./fixtures";
import { useProtoOptions } from "./options";
import { PageBar, ProtoPage, commitClass, searchClass, tabClass, tabsClass } from "./PageBar";
import { LinkRows, stub } from "./parts";

export function Competitions() {
  const { options } = useProtoOptions();
  const [query, setQuery] = useState("");
  const shown = COMPS.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <ProtoPage
      bar={
        <PageBar
          title="Competitions"
          add={
            options.signedIn
              ? { label: "Start a new competition", to: `${P}/comp/new` }
              : undefined
          }
          below={
            <SearchField
              aria-label="Search competitions"
              placeholder="Search competitions"
              variant="floating"
              className={searchClass}
              value={query}
              onChange={setQuery}
            />
          }
        />
      }
    >
      <LinkRows
        label="Competitions"
        empty="No competition matches."
        rows={shown.map((c) => ({
          id: c.id,
          title: c.name,
          detail: `${c.meta} · ${c.dates}`,
          to: `${P}/comp/${c.id}`,
        }))}
      />
    </ProtoPage>
  );
}

export function MyFlights() {
  const { options } = useProtoOptions();
  return (
    <Tabs defaultSelectedKey="tracks" className="gap-0">
      <ProtoPage
        bar={
          <PageBar
            title="My Flights"
            actions={
              options.signedIn
                ? [{ id: "add", label: "Add an .igc track log", onAction: stub("Add a track log") }]
                : []
            }
            below={
              options.signedIn ? (
                <TabList aria-label="My flights" className={tabsClass}>
                  <Tab id="tracks" className={tabClass}>
                    Tracks
                  </Tab>
                  <Tab id="tasks" className={tabClass}>
                    Tasks
                  </Tab>
                </TabList>
              ) : undefined
            }
          />
        }
      >
        {options.signedIn ? (
          <>
            <TabPanel id="tracks">
              <Card>
                <p className="font-medium">No flight tracks yet</p>
                <p className="text-muted-foreground">
                  Add an .igc file from ⋯, or submit a track to a competition.
                </p>
              </Card>
            </TabPanel>
            <TabPanel id="tasks">
              <Card>
                <p className="font-medium">No tasks yet</p>
                <p className="text-muted-foreground">Tasks you save for yourself are listed here.</p>
              </Card>
            </TabPanel>
          </>
        ) : (
          <Card>
            <p className="font-medium">Sign in to see your flights</p>
            <p className="text-muted-foreground">
              Sign in is top right, where a page's main action always is.
            </p>
          </Card>
        )}
      </ProtoPage>
    </Tabs>
  );
}

/**
 * A top-level page that runs one action and shows the result beneath it. Its
 * button stays under the fields, at the end of the steps, and does not go in
 * the bar: the bar's trailing slot is for a page that edits a saved thing and
 * then returns (the wording rule in issue #863).
 */
export function SubmitTrack() {
  const [task, setTask] = useState("3");
  const [who, setWho] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const result = useRef<HTMLDivElement>(null);
  // The result is beneath the button, which may be beneath the screen's edge.
  useEffect(() => {
    if (sent) result.current?.scrollIntoView({ block: "nearest" });
  }, [sent]);
  return (
    <Form
      validate={() => ({ who: who.trim() ? null : "Enter the email you registered with." })}
      onSubmit={() => accepted()}
      onSuccess={() => {
        const name = TASKS.find((t) => t.id === task)?.name ?? "the task";
        setSent(`${file} is in for ${name}. The registered pilot has been emailed.`);
        setFile(null);
      }}
    >
      <ProtoPage bar={<PageBar title="Submit track" />}>
        <ChoiceList
          label="1. Which task did you fly?"
          value={task}
          onChange={setTask}
          options={TASKS.map((t) => ({ value: t.id, label: t.name, description: t.day }))}
        />
        <TextField
          label="2. Who is the track for?"
          description="The email you registered with. Submissions are logged publicly and emailed to the registered pilot."
          name="who"
          type="email"
          inputMode="email"
          value={who}
          onChange={setWho}
        />
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">3. Your IGC file</p>
          <Button
            variant="outline"
            className="h-11 self-start px-4"
            onPress={() => {
              setSent(null);
              setFile(file ? null : "2026-01-07-corryong.igc");
            }}
          >
            {file ? "Remove the file" : "Choose IGC file…"}
          </Button>
          <p className="text-sm text-muted-foreground">
            {file ?? "Submit track is greyed out until a file is chosen."}
          </p>
        </div>
        {/* Beside the button, where it cannot scroll away from it. */}
        <FormErrorBanner />
        <SubmitButton
          className="h-11 self-start px-5 text-[0.9375rem]"
          pendingLabel="Submitting"
          isDisabled={!file}
        >
          Submit track
        </SubmitButton>
        {/* Always in the page, so a screen reader hears the result arrive. */}
        <div ref={result} role="status" className="scroll-mb-4 empty:hidden">
          {sent ? (
            <Card>
              <p className="font-medium">Track submitted</p>
              <p className="text-muted-foreground">{sent}</p>
            </Card>
          ) : null}
        </div>
      </ProtoPage>
    </Form>
  );
}

/** Creating something: Cancel leading, Create trailing. */
export function NewComp() {
  const confirm = useConfirm();
  const leave = useLeave();
  const [name, setName] = useState("");
  const [wing, setWing] = useState("hg");
  const [classes, setClasses] = useState("open");
  const back = `${P}/comp`;
  const dirty = name !== "" || wing !== "hg" || classes !== "open";
  return (
    <Form
      onSubmit={() => accepted()}
      onSuccess={() => {
        toast.success(`Started ${name.trim()}`);
        leave(back);
      }}
    >
      <ProtoPage
        bar={
          <PageBar
            title="New competition"
            trail={[{ label: "Competitions", to: back }]}
            cancel={async () => {
              if (
                dirty &&
                !(await confirm({
                  title: "Discard this competition?",
                  message: "What you have entered will be lost.",
                  confirmLabel: "Discard",
                  cancelLabel: "Keep editing",
                  destructive: true,
                }))
              )
                return;
              leave(back);
            }}
            commit={
              <SubmitButton className={commitClass} pendingLabel="Creating" isDisabled={!name.trim()}>
                Create
              </SubmitButton>
            }
          />
        }
      >
        <FormErrorBanner />
        <TextField
          label="Name"
          name="name"
          placeholder="e.g. Corryong Cup 2027"
          value={name}
          onChange={setName}
        />
        <ChoiceList
          label="Wing"
          value={wing}
          onChange={setWing}
          options={[
            { value: "hg", label: "Hang Gliding" },
            { value: "pg", label: "Paragliding" },
          ]}
        />
        <TextField
          label="Pilot classes"
          description="Separately scored divisions of the field, separated by commas."
          name="classes"
          value={classes}
          onChange={setClasses}
        />
        <p className="text-sm text-muted-foreground">It starts hidden, with no tasks.</p>
      </ProtoPage>
    </Form>
  );
}
