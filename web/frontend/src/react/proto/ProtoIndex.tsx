/**
 * The prototype's contents page (/proto) and its not-found page. The contents
 * page lists every scenario with the one thing to look at in it, and holds
 * the switches for the choices that are still open.
 */
import { LinkButton } from "@/react/rac/button";
import { Card } from "@/react/rac/card";
import { ChoiceList } from "@/react/rac/choice-list";
import { NavList, NavRow } from "@/react/rac/nav-list";
import { SwitchField } from "@/react/rac/switch";
import { COMP, P } from "./fixtures";
import { useProtoOptions } from "./options";
import { PageBar, ProtoPage } from "./PageBar";

const TASK = `${COMP.path}/task/3`;

const SCENARIOS: Array<{ group: string; rows: Array<{ to: string; label: string; look: string }> }> = [
  {
    group: "Top-level pages",
    rows: [
      {
        to: `${P}/comp`,
        label: "Competitions",
        look: "The main menu is top left. The search sticks with the bar. + is top right.",
      },
      { to: `${P}/me`, label: "My Flights", look: "Tabs stick with the bar." },
      {
        to: `${P}/submit`,
        label: "Submit track",
        look: "A top-level page that is a form: its commit button is still top right.",
      },
    ],
  },
  {
    group: "Reading",
    rows: [
      {
        to: COMP.path,
        label: "A competition",
        look: "Back, title, ⋯. The title's menu is one tree: up to the pages above, down to the pages under it, and out.",
      },
      {
        to: `${P}/comp/brasov`,
        label: "A competition with a long name",
        look: "The title is cut short in the bar and printed in full in its menu.",
      },
      {
        to: `${COMP.path}/scores`,
        label: "Scores",
        look: "Class tabs under the bar. Downloads are in ⋯. Recompute shows a status beside ⋯.",
      },
      {
        to: TASK,
        label: "A task",
        look: "Eight actions in ⋯, where there were six pills and two buttons. Submit stays on the page.",
      },
      {
        to: `${TASK}/pilot/rory`,
        label: "A report card",
        look: "Three levels deep. The trail that wrapped to two lines is one menu under the title.",
      },
    ],
  },
  {
    group: "Lists and forms",
    rows: [
      {
        to: `${COMP.path}/pilots`,
        label: "Pilots",
        look: "+ and ⋯ share the trailing slot. The long-named actions are rows in ⋯.",
      },
      {
        to: `${COMP.path}/pilots/brett`,
        label: "Edit a pilot",
        look: "Cancel, title, Save. Save refuses an email with “taken” in it, to show an error under a field far down the page.",
      },
      {
        to: `${COMP.path}/pilots/new`,
        label: "New pilot",
        look: "Cancel, title, Add. Add is greyed out until there is a name.",
      },
      {
        to: `${COMP.path}/pilots/copy`,
        label: "Copy pilots from another competition",
        look: "A name that is a sentence: “Copy pilots” in the bar, the sentence in ⋯ and in the title's menu.",
      },
      {
        to: `${COMP.path}/settings`,
        label: "Competition settings",
        look: "A grouped list. Each row opens a form with Save top right. Delete asks first.",
      },
      {
        to: `${P}/comp/new`,
        label: "New competition",
        look: "Cancel, title, Create.",
      },
    ],
  },
  {
    group: "Drafts",
    rows: [
      {
        to: `${TASK}/route`,
        label: "Route",
        look: "⋯ and Save share the trailing slot. Save is live only while the draft differs.",
      },
      {
        to: `${TASK}/route/3`,
        label: "A turnpoint",
        look: "A page of a draft: Done and Back both return to Route. Nothing is saved until Save there.",
      },
    ],
  },
  {
    group: "Edges",
    rows: [
      { to: `${P}/comp/nowhere`, label: "A page that does not exist", look: "Still has the bar, and a way back." },
    ],
  },
];

export function ProtoIndex() {
  const { options, setOption } = useProtoOptions();
  return (
    <ProtoPage bar={<PageBar title="Page bar prototype" />}>
      <Card>
        <p>
          One bar on every page, stuck to the top. <strong>Left</strong> is the way out.{" "}
          <strong>Centre</strong> is where you are. <strong>Right</strong> is what you can do: a
          form's commit button, or ⋯.
        </p>
        <p className="text-muted-foreground">
          Everything here is sample data. Nothing is saved, and nothing links to this page.
        </p>
      </Card>

      {SCENARIOS.map((s) => (
        <NavList key={s.group} label={s.group}>
          {s.rows.map((r) => (
            <NavRow key={r.to} to={r.to} label={r.label} description={r.look} />
          ))}
        </NavList>
      ))}

      <section className="flex flex-col gap-4">
        <h2 className="px-1 text-lg font-bold">Still open: flip and compare</h2>
        <SwitchField
          checked={options.signedIn}
          onChange={(v) => setOption("signedIn", v)}
          label="Signed in as an organiser"
          hint="Off: organiser actions leave ⋯, and top-level pages show Sign in top right."
        />
        <ChoiceList
          label="A form's leading control"
          value={options.formLeading}
          onChange={(v) => setOption("formLeading", v as typeof options.formLeading)}
          options={[
            { value: "cancel", label: "The word Cancel", description: "As iOS does while editing." },
            { value: "back", label: "The back arrow", description: "One control on every page." },
          ]}
        />
        <ChoiceList
          label="The bar's look"
          value={options.chrome}
          onChange={(v) => setOption("chrome", v as typeof options.chrome)}
          options={[
            { value: "pills", label: "Floating glass pills", description: "The page fades out beneath them." },
            { value: "solid", label: "One solid bar", description: "Full width, with a hairline under it." },
          ]}
        />
      </section>
    </ProtoPage>
  );
}

export function Missing() {
  return (
    <ProtoPage
      bar={<PageBar title="Page not found" trail={[{ label: "Competitions", to: `${P}/comp` }]} />}
    >
      <Card>
        <p className="font-medium">That page is not part of the prototype.</p>
        <LinkButton href={`${P}/comp`} variant="outline" className="h-11 self-start px-5">
          Browse competitions
        </LinkButton>
      </Card>
    </ProtoPage>
  );
}
