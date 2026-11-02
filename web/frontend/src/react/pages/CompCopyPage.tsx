/**
 * Copying a competition into a new one (/comp/:compId/copy) — ADMIN-ONLY and
 * NOT SSR'd (functions/comp/[[path]].ts serves it a noindex shell). Reached
 * from the settings index's "Copy to a new competition".
 *
 * The next edition of a competition is mostly the last one again: the same
 * wing, classes and scoring, the same waypoint file, most of the same
 * pilots. This page starts it from the one it is on.
 *
 *   - The settings always come: a copy without them would be a new
 *     competition, which /comp/new already starts.
 *   - Waypoints, pilots and the other organisers each come unless unticked.
 *     Each is offered only when there is something to copy.
 *   - Tasks never come. A task is set on the day; its route can be copied
 *     into a new task from the route editor instead (TaskRouteCopyPage).
 *   - The copy starts HIDDEN, like every new competition, and the setup
 *     guide on its page walks the rest: review the settings (the close date
 *     is new), the first task, going public.
 *
 * Create goes to the new competition, REPLACING this page in the history, so
 * Back from the copy returns to the settings rather than to a form whose
 * second press would make a second copy. The server's side, and what it
 * leaves behind, is competition-api's routes/comp-copy.ts.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { SettingsPage } from "@/react/components/SettingsPage";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { CheckList, type Choice } from "@/react/rac/choice-list";
import { TextField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton } from "@/react/rac/form";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { suggestCopyName } from "../comp/comp-copy";
import type { CompDetailData } from "../comp/types";
import { underComp } from "../lib/crumbs";
import { compCopyPath, compPath, compUrlId, idFromSegment } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { useAdminView, useUser } from "../lib/user";

const TITLE = "Copy to a new competition";

export function CompCopyPage() {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const { loading } = useUser();

  const { data: comp, notFound, current } = useSeededResource<CompDetailData>({
    ids: [compId],
    seed: null,
    load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    title: (c) => `GlideComp - Copy ${c.name}`,
  });
  const urlId = comp ? compUrlId(comp, compId) : compId;
  useCanonicalPath(comp && current ? compCopyPath(urlId, comp.name) : null);
  const isAdmin = useAdminView(!!comp?.is_admin);

  if (notFound || !compId) return <NotFound title="Competition not found" />;
  if (!comp || loading) return <Loading>Loading competition…</Loading>;

  if (!isAdmin) {
    return (
      <div>
        <Breadcrumbs items={underComp(urlId, comp.name)} current={TITLE} />
        <h1 className="mt-2 text-2xl font-bold">{TITLE}</h1>
        <p className="mt-2 text-muted-foreground">
          Copying a competition is for its organisers.
        </p>
      </div>
    );
  }

  return <CopyForm compId={urlId} comp={comp} />;
}

/** "1 pilot", "80 pilots". */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function CopyForm({ compId, comp }: { compId: string; comp: CompDetailData }) {
  const navigate = useNavigate();
  const { user } = useUser();
  const [name, setName] = useState(() => suggestCopyName(comp.name));

  // The organisers other than the one copying, who is the copy's organiser
  // whatever is ticked.
  const others = comp.admins.filter(
    (a) => a.email.toLowerCase() !== (user?.email ?? "").toLowerCase()
  );
  const options: Choice[] = [];
  if (comp.waypoint_count > 0) {
    options.push({
      value: "waypoints",
      label: "Waypoints",
      description: count(comp.waypoint_count, "waypoint"),
    });
  }
  if (comp.pilot_count > 0) {
    options.push({
      value: "pilots",
      label: "Pilots",
      description: `${count(comp.pilot_count, "pilot")}, without their WPRS points or start order`,
    });
  }
  if (others.length > 0) {
    options.push({
      value: "admins",
      label: "Other organisers",
      description: others.map((a) => a.name || a.email).join(", "),
    });
  }
  // Everything ticked to begin with: a copy is usually of all of it.
  const [bring, setBring] = useState<string[]>(() => options.map((o) => o.value));

  return (
    <SettingsPage
      crumbs={underComp(compId, comp.name)}
      title={TITLE}
      description="Start a new competition from this one. It gets this competition’s settings: wing, pilot classes, scoring and access. It starts hidden, with no tasks."
    >
      <Form
        validate={() => ({ name: name.trim() ? null : "Enter a name." })}
        onSubmit={() =>
          api.api.comp[":comp_id"].clone.$post({
            param: { comp_id: compId },
            json: {
              name: name.trim(),
              waypoints: bring.includes("waypoints"),
              pilots: bring.includes("pilots"),
              admins: bring.includes("admins"),
            },
          })
        }
        onSuccess={async (res) => {
          const created = (await res!.json()) as {
            comp_id: string;
            name: string;
            share_key: string | null;
          };
          // Hidden: open it on the URL that carries its share key, so the
          // address bar is the link to share from the first page. Replace:
          // see the note at the top.
          navigate(compPath(compUrlId(created, created.comp_id), created.name), {
            replace: true,
          });
        }}
        className="flex flex-col gap-6"
      >
        <FormErrorBanner />
        <TextField
          label="Name"
          name="name"
          maxLength={128}
          value={name}
          onChange={setName}
          autoComplete="off"
        />
        {options.length > 0 ? (
          <CheckList label="Also copy" name="bring" value={bring} onChange={setBring} options={options} />
        ) : null}
        <p className="text-sm text-muted-foreground">
          Tasks are not copied. To use a route again, open the new task’s route and choose
          Copy from another competition.
        </p>
        <div>
          <SubmitButton pendingLabel="Creating">Create copy</SubmitButton>
        </div>
      </Form>
    </SettingsPage>
  );
}
