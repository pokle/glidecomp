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
 * Laid out as a real form page is (the pilot page, `comp/PilotForm.tsx`):
 * Done on the header row, the error that belongs to no field under it, then
 * the fields. And laid out to make the rules hard to pass by accident: the
 * field the form checks itself is at the TOP and the one the server refuses
 * is at the BOTTOM, with ten more between them, so on a phone each is off
 * screen when the other is in view.
 *
 * Not routed in a production build (`import.meta.env.DEV`, or the `e2e` mode
 * the e2e suite builds with, in routes.tsx), so neither this page nor its
 * route ships. The copy here is the bench's, never a reader's.
 *
 * Two more requests, for the rules past the submit itself: `onSuccess` reads
 * `/__kit/form-after` before it says Saved (as Create API key reloads the
 * list), and Remove at the foot — asked first, like the pilot page's — sends
 * `/__kit/form-action` through `useFormAction`.
 */
import { useState } from "react";
import { TextField } from "@/react/rac/field";
import { Button } from "@/react/rac/button";
import { Form, FormErrorBanner, SubmitButton, useFormAction } from "@/react/rac/form";
import { SectionHeader } from "../components/SectionHeader";
import { useConfirm } from "../lib/confirm";
import { toast } from "../lib/toast";

const NOTES = Array.from({ length: 10 }, (_, i) => `note_${i + 1}`);

export function KitFormFixture() {
  const [values, setValues] = useState<Record<string, string>>({ name: "", email: "" });
  const set = (key: string) => (value: string) => setValues((v) => ({ ...v, [key]: value }));

  return (
    <div className="max-w-2xl">
      <Form
        validate={() => ({ name: values.name.trim() ? null : "Enter a name." })}
        fieldNames={{ contact_email: "email" }}
        onSubmit={() =>
          fetch("/__kit/form-submit", { method: "POST", body: JSON.stringify(values) })
        }
        onSuccess={async () => {
          await fetch("/__kit/form-after");
          toast.success("Saved the test form");
        }}
      >
        <SectionHeader as="h1" title="Test form" action={<SubmitButton>Done</SubmitButton>} />
        <FormErrorBanner className="mt-3" />
        <div className="mt-4 flex flex-col gap-4">
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
        <FootAction />
      </Form>
    </div>
  );
}

/** An action inside the form that is not its submit, at the foot of it. */
function FootAction() {
  const confirm = useConfirm();
  const removal = useFormAction();
  return (
    <div className="mt-8">
      <Button
        variant="destructive"
        isPending={removal.pending}
        pendingLabel="Removing"
        onPress={async () => {
          const ok = await confirm({
            title: "Remove the test?",
            confirmLabel: "Remove",
            destructive: true,
          });
          if (!ok) return;
          const res = await removal.run(() => fetch("/__kit/form-action", { method: "POST" }));
          if (res) toast.success("Removed the test");
        }}
      >
        Remove
      </Button>
    </div>
  );
}
