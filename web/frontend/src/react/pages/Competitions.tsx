/**
 * Competition list + create dialog. Built on the RAC kit (src/react/rac/) as
 * part of the RAC exploration — see docs/2026-07-18-rac-adoption-guide.md.
 * The filter is client-side over the already-loaded list (a SearchField, not a
 * backend query): the comp count is manageable today; server-side filtering is
 * a later problem (~1,000+ comps).
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link as AriaLink, useFilter } from "react-aria-components";
import { Button } from "@/react/rac/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { SearchField } from "@/react/rac/field";
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
  const [query, setQuery] = useState("");
  const { contains } = useFilter({ sensitivity: "base" });

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

  // Client-side filter: every query word must match somewhere in the comp's
  // name or its meta line (wing / scoring format / classes), so "pg gap" or
  // "corryong 2026" both narrow as expected. Matching is locale-aware and
  // accent/case-insensitive (useFilter sensitivity "base"). An empty query
  // renders the full list — which keeps the SSR markup identical at hydration.
  const words = useMemo(() => query.trim().split(/\s+/).filter(Boolean), [query]);
  const filteredComps =
    visibleComps === null || words.length === 0
      ? visibleComps
      : visibleComps.filter((comp) => {
          const haystack = [
            comp.name,
            categoryLabel(comp.category),
            scoringFormatLabel(comp.scoring_format),
            comp.pilot_classes.join(" "),
          ].join(" ");
          return words.every((word) => contains(haystack, word));
        });

  return (
    <section>
      <div className="flex flex-wrap items-center gap-3">
        <SearchField
          aria-label="Filter competitions"
          placeholder="Filter competitions…"
          value={query}
          onChange={setQuery}
          className="w-full max-w-xs"
        />
        <span className="ml-auto">
          {user ? (
            <Button type="button" onPress={() => setCreateOpen(true)}>
              Start a new competition
            </Button>
          ) : (
            <Button type="button" variant="outline" onPress={() => goToSignIn("/comp")}>
              Sign in to start a competition
            </Button>
          )}
        </span>
      </div>

      {/* Announce filter results to screen readers as the list narrows. */}
      <p role="status" className="sr-only">
        {words.length > 0 && filteredComps !== null && visibleComps !== null
          ? `${filteredComps.length} of ${visibleComps.length} competitions shown`
          : ""}
      </p>

      {loadError ? (
        <p role="alert" className="mt-4">
          Failed to load competitions. Please reload the page.
        </p>
      ) : filteredComps === null ? (
        <p role="status" className="mt-4 text-muted-foreground">
          Loading competitions…
        </p>
      ) : filteredComps.length === 0 ? (
        <p className="mt-4 text-muted-foreground">
          {words.length > 0
            ? `No competitions match “${query.trim()}”.`
            : "No competitions found"}
        </p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {filteredComps.map((comp) => (
            <li key={comp.comp_id}>
              <AriaLink
                href={`/comp/${comp.comp_id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3 transition-colors outline-none data-hovered:bg-muted data-focus-visible:border-ring data-focus-visible:ring-3 data-focus-visible:ring-ring/50"
              >
                <span>
                  <span className="block font-semibold">
                    {comp.name}
                    {comp.test ? (
                      <span className="ml-2 inline-flex items-center rounded-full border px-2 py-0.5 align-middle text-xs font-medium text-muted-foreground">
                        Hidden
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
              </AriaLink>
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
    <Modal isOpen={open} onOpenChange={handleOpenChange} className="sm:max-w-lg">
      <Dialog>
        <DialogHeader>
          <DialogTitle>Start a new competition</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
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
            <Button slot="close" variant="outline">
              Cancel
            </Button>
            <Button type="submit" isDisabled={submitting}>
              {submitting ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
