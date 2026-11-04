/**
 * Starting a new competition (/comp/new) — a PAGE of its own, reached from the
 * + beside the competitions list's search ("Start a new competition"). That +
 * is offered to everyone, so a signed-out reader lands here and is offered
 * sign-in, coming back to this form. Signed-in only, and NOT SSR'd:
 * functions/comp/[[path]].ts serves it a noindex shell.
 *
 * It was a dialog over the list until 2026-11, and a dialog with a text field
 * is the shape the overlays rule in CLAUDE.md retires: on an iPhone, the
 * keyboard and a fixed layer over a scrolled page do not get along. As a page,
 * Back is the browser's Back and a reload keeps the reader where they were.
 *
 * `/comp/new` sits beside the public `/comp/:compId`. React Router ranks the
 * static segment first, and the word cannot be a competition's id anyway: a
 * comp id is at least four characters (competition-api's sqids.ts), so a real
 * comp is never shadowed by it.
 *
 * It is a kit `Form` (rac/form.tsx): the form's own check and the server's
 * refusals land under the field they are about. Create goes to the new
 * competition, REPLACING this page in the history, so Back from the new comp
 * returns to the list rather than to a form that has already been used.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button } from "@/react/rac/button";
import { Form, FormErrorBanner, SubmitButton } from "@/react/rac/form";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { SectionHeader } from "../components/SectionHeader";
import { CategoryField, NameField, PilotClassesField } from "../comp/fields";
import { compCrumbs } from "../lib/crumbs";
import { compPath, compUrlId, newCompPath } from "../lib/slug";
import { useGoToSignIn, useUser } from "../lib/user";

const TITLE = "Start a new competition";

/** What was typed into Pilot classes, as the list the server takes. */
function parseClasses(text: string): string[] {
  const classes = text
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return classes.length > 0 ? classes : ["open"];
}

export function NewCompPage() {
  const { user, loading } = useUser();
  const goToSignIn = useGoToSignIn();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"hg" | "pg">("hg");
  const [pilotClasses, setPilotClasses] = useState("open");

  useEffect(() => {
    document.title = `GlideComp - ${TITLE}`;
  }, []);

  if (loading) return <Loading>Loading…</Loading>;

  return (
    <div className="max-w-2xl">
      <Breadcrumbs items={compCrumbs()} current={TITLE} />
      {user ? (
        <Form
          validate={() => ({ name: name.trim() ? null : "Enter a name." })}
          onSubmit={() =>
            api.api.comp.$post({
              json: {
                name: name.trim(),
                category,
                pilot_classes: parseClasses(pilotClasses),
                // No `test`: a new comp starts hidden, and the setup guide's
                // last step, "Make public", is where it goes public.
              },
            })
          }
          onSuccess={async (res) => {
            const created = (await res!.json()) as {
              comp_id: string;
              name: string;
              test: boolean;
              share_key?: string | null;
            };
            // A new comp starts hidden: open it on the URL that carries its
            // share key, so the organiser's address bar is the link to share
            // from the first page they see.
            navigate(compPath(compUrlId(created, created.comp_id), created.name), {
              replace: true,
            });
          }}
        >
          <SectionHeader
            as="h1"
            className="mt-2"
            title={TITLE}
            action={<SubmitButton pendingLabel="Creating">Create</SubmitButton>}
          />
          <FormErrorBanner className="mt-3" />
          <NewCompFields
            name={name}
            setName={setName}
            category={category}
            setCategory={setCategory}
            pilotClasses={pilotClasses}
            setPilotClasses={setPilotClasses}
          />
        </Form>
      ) : (
        <>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">{TITLE}</h1>
          <Button
            type="button"
            variant="outline"
            className="mt-4"
            onPress={() => goToSignIn(newCompPath())}
          >
            Sign in to start a competition
          </Button>
        </>
      )}
    </div>
  );
}

/** The form's body: inside it, so a chip can clear the field's error. */
function NewCompFields({
  name,
  setName,
  category,
  setCategory,
  pilotClasses,
  setPilotClasses,
}: {
  name: string;
  setName: (v: string) => void;
  category: "hg" | "pg";
  setCategory: (v: "hg" | "pg") => void;
  pilotClasses: string;
  setPilotClasses: (v: string) => void;
}) {
  return (
    <div className="mt-4 flex flex-col gap-6">
      <NameField
        name="name"
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
            Picks the official CIVL scoring defaults (see the{" "}
            <a
              href={`/scoring/gap#defaults-${category}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4"
            >
              {category === "pg" ? "paragliding" : "hang gliding"} defaults
            </a>
            ). Change them later in Settings → Scoring.
          </>
        }
      />

      <PilotClassesField
        name="pilot_classes"
        value={pilotClasses}
        onChange={setPilotClasses}
        wing={category}
      />
    </div>
  );
}
