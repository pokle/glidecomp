/**
 * The kit form's test bench (/__kit/form) — DEVELOPMENT AND E2E BUILDS ONLY.
 *
 * `e2e/forms.spec.ts` drives this page to hold the kit form's rules
 * (rac/form.tsx) on a phone and on a desktop, apart from any real page's
 * fields: Playwright answers its one request (`/__kit/form-submit`) with
 * whatever the test needs — a refusal about a field, one about nothing in
 * particular, a dropped connection, a slow success. A form that is built on
 * the kit then only has to test its own fields.
 *
 * Laid out to make the rules hard to pass by accident: the field the form
 * checks itself is at the TOP and the one the server refuses is at the
 * BOTTOM, with ten more between them, so on a phone each is off screen when
 * the other is in view.
 *
 * Not routed in a production build (`import.meta.env.DEV`, or the `e2e` mode
 * the e2e suite builds with, in routes.tsx), so neither this page nor its
 * route ships. The copy here is the bench's, never a reader's.
 */
import { useState } from "react";
import { Button } from "@/react/rac/button";
import { TextField } from "@/react/rac/field";
import { FormSheet } from "@/react/rac/form";
import { toast } from "../lib/toast";

const NOTES = Array.from({ length: 10 }, (_, i) => `note_${i + 1}`);

export function KitFormFixture() {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({ name: "", email: "" });
  const set = (key: string) => (value: string) => setValues((v) => ({ ...v, [key]: value }));

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Kit form</h1>
      <Button className="w-fit" onPress={() => setOpen(true)}>
        Open the test sheet
      </Button>
      {open ? (
        <FormSheet
          label="Test form"
          title="Test form"
          onClose={() => setOpen(false)}
          validate={() => ({ name: values.name.trim() ? null : "Enter a name." })}
          fieldNames={{ contact_email: "email" }}
          onSubmit={() =>
            fetch("/__kit/form-submit", { method: "POST", body: JSON.stringify(values) })
          }
          onSuccess={() => {
            toast.success("Saved the test form");
            setOpen(false);
          }}
        >
          <div className="flex flex-col gap-4">
            <TextField label="Name" name="name" value={values.name} onChange={set("name")} />
            {NOTES.map((key, i) => (
              <TextField
                key={key}
                label={`Note ${i + 1}`}
                name={key}
                value={values[key] ?? ""}
                onChange={set(key)}
              />
            ))}
            <TextField label="Email" name="email" value={values.email} onChange={set("email")} />
          </div>
        </FormSheet>
      ) : null}
    </main>
  );
}
