/** Competition list + create dialog — React port of comp.ts / comp.html. */
import { useEffect, useId, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/react/ui/button";
import { Checkbox } from "@/react/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/react/ui/field";
import { Input } from "@/react/ui/input";
import { RadioGroup, RadioGroupItem } from "@/react/ui/radio-group";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { signInWithGoogle, useUser } from "../lib/user";
import {
  formatDate,
  formatTaskDateRange,
  categoryLabel,
  scoringFormatLabel,
} from "../lib/format";

interface Comp {
  comp_id: string;
  name: string;
  category: string;
  creation_date: string;
  pilot_classes: string[];
  scoring_format?: string;
  is_admin: boolean;
  test: boolean;
  first_task_date: string | null;
  last_task_date: string | null;
}

export function Competitions() {
  const { user, previewRole } = useUser();
  const navigate = useNavigate();
  const [comps, setComps] = useState<Comp[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    document.title = "GlideComp - Competitions";
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
          <Button type="button" variant="outline" onClick={() => void signInWithGoogle()}>
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
  const nameId = useId();
  const hgId = useId();
  const pgId = useId();
  const classesId = useId();
  const testId = useId();

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
          <Field>
            <FieldLabel htmlFor={nameId}>Name</FieldLabel>
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Corryong Cup 2026"
              required
              maxLength={128}
              autoFocus
            />
          </Field>

          <FieldSet>
            <FieldLegend variant="label">Category</FieldLegend>
            <RadioGroup
              value={category}
              onValueChange={(value) => setCategory(value as "hg" | "pg")}
            >
              <Field orientation="horizontal">
                <RadioGroupItem value="hg" id={hgId} />
                <FieldLabel htmlFor={hgId} className="font-normal">
                  Hang Gliding
                </FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <RadioGroupItem value="pg" id={pgId} />
                <FieldLabel htmlFor={pgId} className="font-normal">
                  Paragliding
                </FieldLabel>
              </Field>
            </RadioGroup>
          </FieldSet>

          <Field>
            <FieldLabel htmlFor={classesId}>Pilot Classes</FieldLabel>
            <Input
              id={classesId}
              value={pilotClasses}
              onChange={(e) => setPilotClasses(e.target.value)}
              placeholder="open, sport, floater"
            />
            <FieldDescription>Comma-separated class names</FieldDescription>
          </Field>

          <Field orientation="horizontal">
            <Checkbox
              id={testId}
              checked={test}
              onCheckedChange={(checked) => setTest(checked === true)}
            />
            <FieldLabel htmlFor={testId} className="font-normal">
              Test competition (only visible to admins)
            </FieldLabel>
          </Field>

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
