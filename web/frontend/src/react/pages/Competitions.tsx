/** Competition list + create dialog — React port of comp.ts / comp.html. */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/react/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import { api } from "../../comp/api";
import { CategoryField, NameField, PilotClassesField, TestCompField } from "../comp/fields";
import { toast } from "../lib/toast";
import { goToSignIn, useUser } from "../lib/user";
import {
  formatDate,
  formatTaskDateRange,
  categoryLabel,
  scoringFormatLabel,
} from "../lib/format";
import { useInitialData } from "../lib/initial-data";
import type { CompListEntry, CompetitionsLoaderData } from "../loaders";

type Comp = CompListEntry;

export function Competitions() {
  const { user, previewRole } = useUser();
  const navigate = useNavigate();
  // SSR: seed from the server loader so the list is in the first paint and the
  // client hydrates the same markup. Client boot / SPA navigations start null.
  const initial = useInitialData<CompetitionsLoaderData>();
  const [comps, setComps] = useState<Comp[] | null>(initial?.comps ?? null);
  const [loadError, setLoadError] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    document.title = "GlideComp - Competitions";
    // Already seeded from SSR — skip the redundant initial fetch.
    if (initial) return;
    (async () => {
      try {
        const res = await api.api.comp.$get();
        if (!res.ok) {
          setLoadError(true);
          return;
        }
        const data = await res.json();
        setComps(data.comps as unknown as Comp[]);
      } catch {
        setLoadError(true);
      }
    })();
    // Seeding is a first-render concern; re-running on `initial` identity is
    // unnecessary (it never changes for a given mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The API returns test comps to their admins; when a superadmin previews a
  // lower role, hide them like the API would for that role.
  const visibleComps =
    comps === null
      ? null
      : previewRole === "out" || previewRole === "pilot"
        ? comps.filter((c) => !c.test)
        : comps;

  return (
    <section>
      <div className="flex justify-end">
        {user ? (
          <Button type="button" onClick={() => setCreateOpen(true)}>
            Start a new competition
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={() => goToSignIn("/comp")}>
            Sign in to start a competition
          </Button>
        )}
      </div>

      {loadError ? (
        <p role="alert" className="mt-4">
          Failed to load competitions. Please reload the page.
        </p>
      ) : visibleComps === null ? (
        <p role="status" className="mt-4 text-muted-foreground">
          Loading competitions…
        </p>
      ) : visibleComps.length === 0 ? (
        <p className="mt-4 text-muted-foreground">No competitions found</p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {visibleComps.map((comp) => (
            <li key={comp.comp_id}>
              <Link
                to={`/comp/${comp.comp_id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3 transition-colors hover:bg-muted"
              >
                <span>
                  <span className="block font-semibold">
                    {comp.name}
                    {comp.test ? (
                      <span className="ml-2 inline-flex items-center rounded-full border px-2 py-0.5 align-middle text-xs font-medium text-muted-foreground">
                        Test
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {[
                      categoryLabel(comp.category),
                      scoringFormatLabel(comp.scoring_format),
                      comp.pilot_classes.join(", "),
                    ].join(" · ")}
                  </span>
                </span>
                <span className="ml-auto text-sm whitespace-nowrap text-muted-foreground">
                  {comp.first_task_date && comp.last_task_date
                    ? formatTaskDateRange(comp.first_task_date, comp.last_task_date)
                    : `created ${formatDate(comp.creation_date)}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <CreateCompDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(compId) => navigate(`/comp/${compId}`)}
      />
    </section>
  );
}

function CreateCompDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (compId: string) => void;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"hg" | "pg">("hg");
  const [pilotClasses, setPilotClasses] = useState("open");
  const [test, setTest] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset the form each time the dialog opens (matches the vanilla behaviour).
  function handleOpenChange(next: boolean) {
    if (next) {
      setName("");
      setCategory("hg");
      setPilotClasses("open");
      setTest(false);
    }
    onOpenChange(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const classes = pilotClasses
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    try {
      const res = await api.api.comp.$post({
        json: {
          name: name.trim(),
          category,
          pilot_classes: classes.length > 0 ? classes : ["open"],
          test,
        },
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error((err as { error?: string }).error || "Failed to create competition");
        return;
      }
      const data = await res.json();
      onOpenChange(false);
      onCreated((data as { comp_id: string }).comp_id);
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Competition</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <NameField
            value={name}
            onChange={setName}
            placeholder="e.g. Corryong Cup 2026"
            autoFocus
          />

          <CategoryField
            value={category}
            onChange={setCategory}
            description={
              <>
                Sets the official CIVL GAP scoring defaults for your wing — see the{" "}
                <a
                  href={`/scoring/gap#defaults-${category}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4"
                >
                  {category === "pg" ? "paragliding" : "hang gliding"} defaults
                </a>
                . You can fine-tune them later in the competition's Advanced settings.
              </>
            }
          />

          <PilotClassesField value={pilotClasses} onChange={setPilotClasses} wing={category} />

          <TestCompField checked={test} onChange={setTest} />

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
