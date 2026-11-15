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
 * It is a kit `Form` (rac/form.tsx, through SettingsForm): the form's own
 * check and the server's refusals land under the field they are about.
 * Create is in the bar (issue #863), live once there is a name. It goes to the new
 * competition, REPLACING this page in the history, so Back from the new comp
 * returns to the list rather than to a form that has already been used.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SettingsForm } from "@/react/components/SettingsForm";
import { SettingsPage } from "@/react/components/SettingsPage";
import { Button } from "@/react/rac/button";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { CategoryField, NameField, PilotClassesField } from "../comp/fields";
import { compCrumbs } from "../lib/crumbs";
import { compPath, compUrlId, newCompPath } from "../lib/slug";
import { useGoToSignIn, useUser } from "../lib/user";

/** The bar has one line: the short name there, the sentence in its menu. */
const TITLE = "New competition";
const FULL_TITLE = "Start a new competition";

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
    document.title = `GlideComp - ${FULL_TITLE}`;
  }, []);

  if (loading || !user) {
    // The bar is there before the session is known, so the page does not
    // jump. Signed out, there is no form to cancel: a page to go back from.
    return (
      <SettingsPage crumbs={compCrumbs()} title={TITLE} fullTitle={FULL_TITLE}>
        {loading ? (
          <Loading>Loading…</Loading>
        ) : (
          <div>
            <Button type="button" variant="outline" onPress={() => goToSignIn(newCompPath())}>
              Sign in to start a competition
            </Button>
          </div>
        )}
      </SettingsPage>
    );
  }

  return (
    <SettingsForm
      crumbs={compCrumbs()}
      title={TITLE}
      fullTitle={FULL_TITLE}
      // Something typed or changed is something Cancel would throw away.
      dirty={name !== "" || category !== "hg" || pilotClasses !== "open"}
      // A form that makes something new: live once it has a name.
      canCommit={name.trim() !== ""}
      submitLabel="Create"
      pendingLabel="Creating"
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
      <NewCompFields
        name={name}
        setName={setName}
        category={category}
        setCategory={setCategory}
        pilotClasses={pilotClasses}
        setPilotClasses={setPilotClasses}
      />
    </SettingsForm>
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
    <div className="flex flex-col gap-6">
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
