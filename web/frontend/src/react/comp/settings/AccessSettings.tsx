/**
 * Access settings sub-page: visibility, who can register, who can record
 * flights, when submissions close, and the admin list. Copy carried over
 * verbatim from the old settings dialog.
 *
 * A hidden comp is not private to its admins: anyone its URL is sent to can
 * read it, because that URL carries the comp's share key (lib/slug.ts
 * compUrlId). "Reset link" is the way to take that back — a new key, and every
 * link shared so far stops working.
 *
 * Close Date sits with the two "let pilots…" switches rather than on the
 * General page: all three answer the same question — who may put a track
 * into this competition, and until when.
 */
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SettingsPage } from "@/react/components/SettingsPage";
import { Button } from "@/react/rac/button";
import { SettingsForm } from "@/react/components/SettingsForm";
import { Label, TextField } from "@/react/rac/field";
import { DatePicker } from "@/react/rac/date-picker";
import { api } from "@/comp/api";
import { toast } from "@/react/lib/toast";
import { ActionErrorBanner, useAction } from "@/react/rac/form";
import { underCompSettings } from "@/react/lib/crumbs";
import { useConfirm } from "@/react/lib/confirm";
import { bareCompId, compSettingsPath, compUrlId } from "@/react/lib/slug";
import { SwitchField, SwitchList } from "@/react/rac/switch";
import type { SettingsGroupProps } from "./CompSettingsIndex";

export function AccessSettings({ compId, comp, onSaved }: SettingsGroupProps) {
  const closeDateId = useId();
  const savedAdmins = comp.admins.map((a) => a.email).join(", ");
  const savedCloseDate = comp.close_date ? comp.close_date.split("T")[0] : "";

  const [test, setTest] = useState(comp.test);
  const [openRegistration, setOpenRegistration] = useState(
    comp.open_registration ?? true
  );
  const [openUpload, setOpenUpload] = useState(comp.open_igc_upload ?? true);
  const [closeDate, setCloseDate] = useState(savedCloseDate);
  const [adminsText, setAdminsText] = useState(savedAdmins);
  // A one-press action inside the form: its refusal goes beside it.
  const reset = useAction();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const dirty =
    test !== comp.test ||
    openRegistration !== (comp.open_registration ?? true) ||
    openUpload !== (comp.open_igc_upload ?? true) ||
    closeDate !== savedCloseDate ||
    adminsText !== savedAdmins;

  const adminEmails = adminsText
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  /** A new share key. The page moves onto the URL that carries it, so the
   * address bar is the new link to send. */
  async function resetLink() {
    const confirmed = await confirm({
      title: "Reset link?",
      message: "Every link you’ve shared so far stops working.",
      confirmLabel: "Reset link",
      destructive: true,
    });
    if (!confirmed) return;
    const res = await reset.run(
      () => api.api.comp[":comp_id"]["share-key"].$post({ param: { comp_id: compId } }),
      { fallback: "Failed to reset the link." }
    );
    if (!res) return;
    const { share_key } = (await res.json()) as { share_key: string };
    toast.success("Link reset");
    navigate(
      compSettingsPath(
        compUrlId({ comp_id: bareCompId(comp.comp_id), test: true, share_key }, compId),
        comp.name,
        "access"
      ),
      { replace: true }
    );
  }

  return (
    <SettingsPage crumbs={underCompSettings(compId, comp.name)} title="Access">
      <SettingsForm
        dirty={dirty}
        validate={() => ({
          admin_emails: adminEmails.length === 0 && "At least one admin email is required",
        })}
        onSubmit={() =>
          api.api.comp[":comp_id"].$patch({
            param: { comp_id: compId },
            json: {
              test,
              open_registration: openRegistration,
              open_igc_upload: openUpload,
              close_date: closeDate || null,
              admin_emails: adminEmails,
            },
          })
        }
        onSuccess={onSaved}
      >
        {/* The three booleans share one card, as consecutive settings rows do
            on a phone. "Hidden?" is the only place a comp's visibility is
            set: a new comp starts hidden, and the setup guide's "Make public"
            step links here. */}
        <SwitchList>
          <SwitchField
            name="test"
            checked={test}
            onChange={setTest}
            label="Hidden?"
            hint="Not in the competition list or search. Only admins, and people you send this competition’s link to, can see it."
          />
          <SwitchField
            name="open_registration"
            checked={openRegistration}
            onChange={setOpenRegistration}
            label="Let pilots register themselves by submitting a track"
            hint="When off, only admins add pilots. Registered pilots can always submit."
          />
          <SwitchField
            name="open_igc_upload"
            checked={openUpload}
            onChange={setOpenUpload}
            label="Let registered pilots record flights and statuses for each other"
            hint="Uploading tracks, recording manual flights, and marking Absent / Did Not Fly. Admins always can."
          />
        </SwitchList>

        {/* Only a hidden comp has a link to take back: a public one is open
            to everyone at its plain URL. */}
        {comp.test ? (
          <div className="flex flex-col items-start gap-2">
            <Button
              variant="outline"
              size="sm"
              onPress={() => void resetLink()}
              isPending={reset.pending}
              pendingLabel="Resetting link"
            >
              Reset link
            </Button>
            <ActionErrorBanner action={reset} />
            <p className="text-xs text-muted-foreground">
              Every link you’ve shared so far stops working.
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <Label id={closeDateId}>Close date</Label>
          <DatePicker
            inline
            clearable
            name="close_date"
            aria-labelledby={closeDateId}
            value={closeDate}
            onChange={setCloseDate}
          />
          <p className="text-xs text-muted-foreground">
            Tracks are refused after this date. Leave empty for no limit.
          </p>
        </div>

        {/* A refusal about one address ("admin_emails.1") lands here: the
            kit form reads a list item's refusal as its list's. */}
        <TextField
          label="Admin emails"
          name="admin_emails"
          placeholder="admin1@example.com, admin2@example.com"
          value={adminsText}
          onChange={setAdminsText}
          description="Comma-separated. At least one required."
        />
      </SettingsForm>
    </SettingsPage>
  );
}
