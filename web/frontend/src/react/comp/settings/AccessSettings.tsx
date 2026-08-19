/**
 * Access settings sub-page: visibility, who can register, who can record
 * flights, and the admin list. Copy carried over verbatim from the old
 * settings dialog.
 */
import { useState } from "react";
import { SettingsPage } from "@/react/components/SettingsPage";
import { SettingsForm } from "@/react/components/SettingsForm";
import { TextField } from "@/react/rac/field";
import { api } from "@/comp/api";
import { toast } from "@/react/lib/toast";
import { underCompSettings } from "@/react/lib/crumbs";
import { CheckboxField, TestCompField } from "../fields";
import type { SettingsGroupProps } from "./CompSettingsIndex";

export function AccessSettings({ compId, comp, onSaved }: SettingsGroupProps) {
  const savedAdmins = comp.admins.map((a) => a.email).join(", ");
  const [test, setTest] = useState(comp.test);
  const [openRegistration, setOpenRegistration] = useState(
    comp.open_registration ?? true
  );
  const [openUpload, setOpenUpload] = useState(comp.open_igc_upload ?? true);
  const [adminsText, setAdminsText] = useState(savedAdmins);
  const [saving, setSaving] = useState(false);

  const dirty =
    test !== comp.test ||
    openRegistration !== (comp.open_registration ?? true) ||
    openUpload !== (comp.open_igc_upload ?? true) ||
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
        <TestCompField checked={test} onChange={setTest} />
        <CheckboxField
          checked={openRegistration}
          onChange={setOpenRegistration}
          label="Let pilots register themselves by submitting a track"
          hint="Off, only admins add pilots. Pilots you registered can always submit."
        />
        <CheckboxField
          checked={openUpload}
          onChange={setOpenUpload}
          label="Let registered pilots record flights and statuses for each other"
          hint="Covers uploading IGC tracks, recording manual flights, and setting pilot statuses (Absent / Did Not Fly). Admins can always do these regardless of this setting."
        />

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
