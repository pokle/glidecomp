/**
 * The competition settings index — grouped tappable rows, each opening a
 * focused sub-page (see pages/CompSettingsPage.tsx for the why). Row values
 * summarise the stored settings so an admin can see the state of the comp
 * without opening every group.
 *
 * "Delete competition" lives here as a destructive row rather than on a
 * sub-page: it is an action, not a setting, and burying it a level down
 * would only make it easier to press by accident next to a Save button.
 */
import { useNavigate } from "react-router-dom";
import { NavActionRow, NavList, NavRow } from "@/react/rac/nav-list";
import { SettingsPage } from "@/react/components/SettingsPage";
import { api } from "@/comp/api";
import { toast } from "@/react/lib/toast";
import { useConfirm } from "@/react/lib/confirm";
import { underComp } from "@/react/lib/crumbs";
import { compSettingsPath } from "@/react/lib/slug";
import type { CompDetailData } from "../types";
import { GeneralSettings } from "./GeneralSettings";
import { ClassesSettings } from "./ClassesSettings";
import { ScoringSettings } from "./ScoringSettings";
import { AccessSettings } from "./AccessSettings";

export const SETTINGS_GROUPS = [
  "general",
  "access",
  "classes",
  "scoring",
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export interface SettingsGroupProps {
  compId: string;
  comp: CompDetailData;
  /** Called after a successful save; the caller refreshes and goes up. */
  onSaved: () => void;
}

/** One sub-page component per group, dispatched by the route param. */
export function SettingsGroupPage({
  group,
  ...props
}: SettingsGroupProps & { group: SettingsGroup }) {
  switch (group) {
    case "general":
      return <GeneralSettings {...props} />;
    case "access":
      return <AccessSettings {...props} />;
    case "classes":
      return <ClassesSettings {...props} />;
    case "scoring":
      return <ScoringSettings {...props} />;
  }
}

function scoringSummary(comp: CompDetailData): string {
  if (comp.scoring_format === "open_distance") return "Open distance";
  return comp.series_scoring === "ftv" ? "GAP · FTV" : "GAP";
}

function accessSummary(comp: CompDetailData): string {
  return [
    comp.test ? "Hidden" : null,
    (comp.open_registration ?? true) ? "Open registration" : "Admins add pilots",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function CompSettingsIndex({
  compId,
  comp,
}: {
  compId: string;
  comp: CompDetailData;
}) {
  const navigate = useNavigate();
  const confirm = useConfirm();

  async function deleteComp() {
    const confirmed = await confirm({
      title: "Delete this competition?",
      message: "All its tasks and tracks will be deleted. This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      const res = await api.api.comp[":comp_id"].$delete({ param: { comp_id: compId } });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to delete competition");
        return;
      }
      navigate("/comp");
    } catch {
      toast.error("Network error. Please try again.");
    }
  }

  const groupPath = (group: SettingsGroup) =>
    compSettingsPath(compId, comp.name, group);

  return (
    <SettingsPage crumbs={underComp(compId, comp.name)} title="Settings">
      <NavList>
        <NavRow to={groupPath("general")} label="General" value={comp.name} />
        <NavRow
          to={groupPath("access")}
          label="Access"
          value={accessSummary(comp)}
        />
        <NavRow
          to={groupPath("classes")}
          label="Pilot classes"
          value={comp.pilot_classes.join(", ")}
        />
        <NavRow
          to={groupPath("scoring")}
          label="Scoring"
          value={scoringSummary(comp)}
        />
      </NavList>
      <NavList label="Danger zone">
        <NavActionRow
          destructive
          label="Delete competition"
          onPress={() => void deleteComp()}
        />
      </NavList>
    </SettingsPage>
  );
}
