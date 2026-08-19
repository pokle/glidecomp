/**
 * Access settings sub-page: visibility, who can register, who can record
 * flights, when submissions close, and the admin list. Copy carried over
 * verbatim from the old settings dialog.
 *
 * Close Date sits with the two "let pilots…" switches rather than on the
 * General page: all three answer the same question — who may put a track
 * into this competition, and until when.
 */
import { useId, useState } from "react";
import { SettingsPage } from "@/react/components/SettingsPage";
import { SettingsForm } from "@/react/components/SettingsForm";
import { Label, TextField } from "@/react/rac/field";
import { DatePicker } from "@/react/rac/date-picker";
import { api } from "@/comp/api";
import { toast } from "@/react/lib/toast";
import { underCompSettings } from "@/react/lib/crumbs";
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
  const [saving, setSaving] = useState(false);

  const dirty =
    test !== comp.test ||
    openRegistration !== (comp.open_registration ?? true) ||
    openUpload !== (comp.open_igc_upload ?? true) ||
    closeDate !== savedCloseDate ||
    adminsText !== savedAdmins;

  async function save() {
    const adminEmails = adminsText
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (adminEmails.length === 0) {
      toast.warning("At least one admin email is required");
      return;
    }
    setSaving(true);
    try {
      const res = await api.api.comp[":comp_id"].$patch({
        param: { comp_id: compId },
        json: {
          test,
          open_registration: openRegistration,
          open_igc_upload: openUpload,
          close_date: closeDate || null,
          admin_emails: adminEmails,
        },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to update competition");
        return;
      }
      onSaved();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsPage crumbs={underCompSettings(compId, comp.name)} title="Access">
      <SettingsForm onSave={save} saving={saving} dirty={dirty}>
        {/* The three booleans share one card, as consecutive settings rows do
            on a phone. "Hidden?" keeps the copy TestCompField carries in the
            dialogs, which still use the compact checkbox form. */}
        <SwitchList>
          <SwitchField
            checked={test}
            onChange={setTest}
            label="Hidden?"
            hint="Hidden from the public and pilots — only admins can see it."
          />
          <SwitchField
            checked={openRegistration}
            onChange={setOpenRegistration}
            label="Let pilots register themselves by submitting a track"
            hint="Off, only admins add pilots. Pilots you registered can always submit."
          />
          <SwitchField
            checked={openUpload}
            onChange={setOpenUpload}
            label="Let registered pilots record flights and statuses for each other"
            hint="Covers uploading IGC tracks, recording manual flights, and setting pilot statuses (Absent / Did Not Fly). Admins can always do these regardless of this setting."
          />
        </SwitchList>

        <div className="flex flex-col gap-2">
          <Label id={closeDateId}>Close Date</Label>
          <DatePicker
            inline
            clearable
            aria-labelledby={closeDateId}
            value={closeDate}
            onChange={setCloseDate}
          />
          <p className="text-xs text-muted-foreground">
            After this date, track submissions are rejected. Leave empty for open-ended.
          </p>
        </div>

        <TextField
          label="Admin Emails"
          placeholder="admin1@example.com, admin2@example.com"
          value={adminsText}
          onChange={setAdminsText}
          description="Comma-separated. At least one required."
        />
      </SettingsForm>
    </SettingsPage>
  );
}
