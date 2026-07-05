/** Competition list + create dialog — React port of comp.ts / comp.html. */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Checkbox } from "@base-ui/react/checkbox";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useUser } from "../lib/user";
import { formatDate, categoryLabel } from "../lib/format";

interface Comp {
  comp_id: string;
  name: string;
  category: string;
  creation_date: string;
  pilot_classes: string[];
  is_admin: boolean;
  test: boolean;
}

export function Competitions() {
  const { user } = useUser();
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

  return (
    <section>
      <h1>Competitions</h1>
      <p>Manage and score your competitions</p>
      {user ? (
        <button type="button" onClick={() => setCreateOpen(true)}>
          New Competition
        </button>
      ) : null}

      {loadError ? (
        <p role="alert">Failed to load competitions. Please reload the page.</p>
      ) : comps === null ? (
        <p role="status">Loading competitions…</p>
      ) : comps.length === 0 ? (
        <p>No competitions found</p>
      ) : (
        <ul>
          {comps.map((comp) => (
            <li key={comp.comp_id}>
              <Link to={`/comp/${comp.comp_id}`}>{comp.name}</Link>{" "}
              <span>{categoryLabel(comp.category)}</span>
              {comp.test ? <span> Test</span> : null}{" "}
              <span>{comp.pilot_classes.join(", ")}</span>{" "}
              <span>{formatDate(comp.creation_date)}</span>
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
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup>
          <Dialog.Title>Create Competition</Dialog.Title>
          <form onSubmit={handleSubmit}>
            <Field.Root>
              <Field.Label>Name</Field.Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Corryong Cup 2026"
                required
                maxLength={128}
                autoFocus
              />
            </Field.Root>

            <Field.Root>
              <Field.Label>Category</Field.Label>
              <RadioGroup
                value={category}
                onValueChange={(value) => setCategory(value as "hg" | "pg")}
              >
                {/* Text glyphs: like the checkbox, an unselected Base UI
                    radio is a zero-size span until styled. */}
                <label>
                  <Radio.Root value="hg">{category === "hg" ? "◉" : "○"}</Radio.Root>
                  Hang Gliding
                </label>
                <label>
                  <Radio.Root value="pg">{category === "pg" ? "◉" : "○"}</Radio.Root>
                  Paragliding
                </label>
              </RadioGroup>
            </Field.Root>

            <Field.Root>
              <Field.Label>Pilot Classes</Field.Label>
              <Input
                value={pilotClasses}
                onChange={(e) => setPilotClasses(e.target.value)}
                placeholder="open, sport, floater"
              />
              <Field.Description>Comma-separated class names</Field.Description>
            </Field.Root>

            <label>
              {/* Text glyph for both states: an unchecked Base UI checkbox is
                  an empty (zero-size) span until styled, i.e. invisible and
                  unclickable in this unstyled UI. */}
              <Checkbox.Root checked={test} onCheckedChange={(checked) => setTest(checked === true)}>
                {test ? "☑" : "☐"}
              </Checkbox.Root>
              Test competition (only visible to admins)
            </label>

            <div>
              <Dialog.Close>Cancel</Dialog.Close>
              <button type="submit" disabled={submitting}>
                {submitting ? "Creating..." : "Create"}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
