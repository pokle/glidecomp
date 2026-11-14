/**
 * Copying the pilots of another competition into this roster
 * (/comp/:compId/pilots/copy[?from=<compId>]) — ADMIN-ONLY and NOT SSR'd
 * (functions/comp/[[path]].ts serves it a noindex shell, like the roster it
 * belongs to). Reached from the pilots list's ⋯ menu, left with Back.
 *
 * Two steps, and the step is in the URL, so Back walks them and a reload
 * stays where it was:
 *
 *   1. no `from`: the organiser's other competitions that have pilots;
 *   2. `?from=<compId>`: what copying that roster would do, worked out by the
 *      server against both rosters as they are now, and the button that does
 *      it.
 *
 * A copy ADDS pilots. Nobody already on this roster is changed or removed,
 * and a pilot already here (the same account, a sporting-body ID or an email)
 * is left out and listed with the reason. A name alone never decides that,
 * so a same-named pilot is copied and pointed out, for the organiser to
 * delete if it is the same person. The rules are competition-api's
 * roster-copy.ts; this page only shows them.
 */
import { Link, useSearchParams } from "react-router-dom";
import { Alert, AlertDescription } from "@/react/rac/alert";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button } from "@/react/rac/button";
import { Form, FormErrorBanner, SubmitButton, useFormState } from "@/react/rac/form";
import { NavList, NavRow } from "@/react/rac/nav-list";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { SectionHeader } from "../components/SectionHeader";
import { useRosterAdminPage, type RosterAdminPage } from "../comp/use-roster-admin-page";
import { underCompPilots } from "../lib/crumbs";
import { formatTaskDate } from "../lib/format";
import { compPilotsCopyPath } from "../lib/slug";
import { toast } from "../lib/toast";
import { useSeededResource } from "../lib/use-seeded-resource";

const TITLE = "Copy pilots from another competition";

type ReadyPage = Extract<RosterAdminPage, { ready: true }>;

interface CopySource {
  comp_id: string;
  name: string;
  test: boolean;
  pilot_count: number;
  first_task_date: string | null;
}

interface CopyPreview {
  from: { comp_id: string; name: string };
  copy: Array<{
    name: string;
    pilot_class: string;
    team_name: string | null;
    linked: boolean;
    same_name_as: string | null;
  }>;
  skip: Array<{ name: string; reason: string }>;
  remapped: Array<{ from: string; to: string; count: number }>;
  error: string | null;
}

/** "1 pilot", "25 pilots". */
function pilots(n: number): string {
  return `${n} ${n === 1 ? "pilot" : "pilots"}`;
}

export function CompPilotsCopyPage() {
  const page = useRosterAdminPage({
    current: TITLE,
    canonicalPath: (urlId, name) => compPilotsCopyPath(urlId, name),
  });
  const [params] = useSearchParams();
  const from = params.get("from");

  if (!page.ready) return page.element;
  return from ? <CopyReview page={page} from={from} /> : <ChooseSource page={page} />;
}

/** Step 1: which competition to copy from. */
function ChooseSource({ page }: { page: ReadyPage }) {
  const { data, notFound } = useSeededResource<{ comps: CopySource[] }>({
    ids: [page.urlId],
    seed: null,
    load: ([comp_id]) =>
      api.api.comp[":comp_id"].pilot["copy-sources"].$get({ param: { comp_id } }),
  });

  return (
    <div className="max-w-2xl">
      <Breadcrumbs items={underCompPilots(page.urlId, page.comp.name)} current={TITLE} />
      <h1 className="mt-2 text-2xl font-bold">{TITLE}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Adds the pilots of one of your other competitions to this one. Nobody already here is
        changed or removed, and you can edit or delete any pilot afterwards.
      </p>
      <div className="mt-6">
        {notFound ? (
          <p className="text-muted-foreground">Could not load your competitions. Try again.</p>
        ) : !data ? (
          <Loading>Loading your competitions…</Loading>
        ) : data.comps.length === 0 ? (
          <p className="text-muted-foreground">None of your other competitions has pilots.</p>
        ) : (
          <NavList label="Your competitions">
            {data.comps.map((c) => (
              <NavRow
                key={c.comp_id}
                to={compPilotsCopyPath(page.urlId, page.comp.name, c.comp_id)}
                label={c.name}
                description={[
                  c.first_task_date ? formatTaskDate(c.first_task_date) : null,
                  c.test ? "Hidden" : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined}
                value={pilots(c.pilot_count)}
              />
            ))}
          </NavList>
        )}
      </div>
    </div>
  );
}

/** Step 2: what copying `from` would do, and the button that does it. */
function CopyReview({ page, from }: { page: ReadyPage; from: string }) {
  const { data, notFound, current } = useSeededResource<CopyPreview>({
    ids: [page.urlId, from],
    seed: null,
    load: ([comp_id, fromId]) =>
      api.api.comp[":comp_id"].pilot.copy.$get({ param: { comp_id }, query: { from: fromId } }),
  });
  const chooseAgain = compPilotsCopyPath(page.urlId, page.comp.name);
  const crumbs = underCompPilots(page.urlId, page.comp.name);

  if (notFound) {
    return (
      <div className="max-w-2xl">
        <Breadcrumbs items={crumbs} current={TITLE} />
        <h1 className="mt-2 text-2xl font-bold">{TITLE}</h1>
        <p className="mt-2 text-muted-foreground">
          That competition was not found, or you are not one of its organisers.{" "}
          <Link className="underline underline-offset-4" to={chooseAgain}>
            Choose another competition
          </Link>
          .
        </p>
      </div>
    );
  }
  if (!data || !current) return <Loading>Working out what to copy…</Loading>;

  const n = data.copy.length;
  const canCopy = n > 0 && !data.error;
  return (
    <div className="max-w-2xl">
      <Breadcrumbs items={crumbs} current={TITLE} />
      <Form
        onSubmit={() =>
          api.api.comp[":comp_id"].pilot.copy.$post({
            param: { comp_id: page.urlId },
            json: { from_comp_id: from },
          })
        }
        onSuccess={async (res) => {
          const done = (await res!.json()) as { copied: number; from: { name: string } };
          toast.success(`Copied ${pilots(done.copied)} from ${done.from.name}`);
          page.leave();
        }}
      >
        <ReviewHeader
          title={`Copy pilots from ${data.from.name}`}
          onCancel={page.leave}
          submit={
            canCopy ? (
              <SubmitButton pendingLabel="Copying">{`Copy ${pilots(n)}`}</SubmitButton>
            ) : null
          }
        />
        <p className="mt-1 text-sm text-muted-foreground">
          {`${n} to copy · ${data.skip.length} already here`}
        </p>
        <FormErrorBanner className="mt-3" />
        <div className="mt-4 flex flex-col gap-6">
          {data.error ? (
            <Alert variant="destructive">
              <AlertDescription>{data.error}</AlertDescription>
            </Alert>
          ) : null}
          {data.remapped.length > 0 ? (
            <Alert>
              <AlertDescription>
                {data.remapped.map((r) => (
                  <p key={r.from}>
                    This competition has no class “{r.from}”, so {pilots(r.count)} from it will
                    be in “{r.to}”.
                  </p>
                ))}
              </AlertDescription>
            </Alert>
          ) : null}
          {n === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every pilot in {data.from.name} is already on this roster. There is nothing to
              copy.
            </p>
          ) : null}

          <ReviewSection title="To copy" count={n}>
            {data.copy.map((p, i) => (
              <li key={i} className="py-2">
                <p className="font-medium">{p.name}</p>
                <p className="text-xs text-muted-foreground">
                  {[p.pilot_class, p.team_name].filter(Boolean).join(" · ")}
                </p>
                {p.same_name_as ? (
                  <p className="text-xs font-medium">
                    Same name as {p.same_name_as}, who is already here. Delete one afterwards if
                    they are the same pilot.
                  </p>
                ) : null}
              </li>
            ))}
          </ReviewSection>
          <ReviewSection title="Already here" count={data.skip.length}>
            {data.skip.map((p, i) => (
              <li key={i} className="py-2">
                <p className="font-medium">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.reason}</p>
              </li>
            ))}
          </ReviewSection>
          <p className="text-sm">
            <Link className="underline underline-offset-4" to={chooseAgain}>
              Choose a different competition
            </Link>
          </p>
        </div>
      </Form>
    </div>
  );
}

/** The page's title with Cancel and the submit beside it, as the import's. */
function ReviewHeader({
  title,
  onCancel,
  submit,
}: {
  title: string;
  onCancel: () => void;
  submit: React.ReactNode;
}) {
  const { pending } = useFormState();
  return (
    <SectionHeader
      as="h1"
      className="mt-2"
      title={<span className="[overflow-wrap:anywhere]">{title}</span>}
      action={
        <div className="flex gap-2">
          <Button variant="outline" isDisabled={pending} onPress={onCancel}>
            Cancel
          </Button>
          {submit}
        </div>
      }
    />
  );
}

function ReviewSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold">
        {title} ({count})
      </h2>
      <ul className="divide-y divide-border">{children}</ul>
    </section>
  );
}
