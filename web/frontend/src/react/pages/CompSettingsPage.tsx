/**
 * Competition settings (/comp/:id/settings[/:group]) — ADMIN-ONLY and NOT
 * SSR'd (functions/comp/[[path]].ts serves it a noindex shell).
 *
 * The settings used to be one 21-control dialog over the comp page. They are
 * now a hierarchy of routed pages — an index of grouped rows, each opening a
 * focused sub-page — because the app is used on phones on the hill, and a
 * form taller than the viewport inside a centred modal is the desktop-most
 * thing an app can do. One pattern at every viewport size; the browser back
 * button and shareable URLs come free with real routes.
 *
 * The sub-pages save independently: PATCH /api/comp/:comp_id takes partial
 * bodies (every field optional; the server diffs per field for its audit
 * sentences and score bumps), so each page sends only its own group's fields.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underComp } from "../lib/crumbs";
import { idFromSegment, compSettingsPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import type { CompDetailData } from "../comp/types";
import {
  CompSettingsIndex,
  SETTINGS_GROUPS,
  SettingsGroupPage,
  type SettingsGroup,
} from "../comp/settings/CompSettingsIndex";

export function CompSettingsPage() {
  const { compId: compParam, group } = useParams<{
    compId: string;
    group?: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const navigate = useNavigate();
  const { user, loading } = useUser();
  // Bumped after a sub-page save so the index re-reads the stored values
  // rather than showing the seed it loaded before the edit.
  const [refresh, setRefresh] = useState(0);
  const { data: comp, notFound } = useSeededResource<CompDetailData>({
    ids: [compId],
    seed: null,
    load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    title: (c) => `GlideComp - ${c.name} settings`,
    refresh,
  });
  // Settle the address bar on the canonical `${slug}-${id}/settings[/group]`.
  useCanonicalPath(comp ? compSettingsPath(compId, comp.name, group) : null);

  const isAdmin = useAdminView(
    user != null && comp != null && comp.admins.some((a) => a.email === user.email)
  );

  if (notFound || !compId) {
    return <NotFound title="Competition not found" />;
  }
  if (group !== undefined && !SETTINGS_GROUPS.includes(group as SettingsGroup)) {
    return <NotFound />;
  }

  if (!comp || loading) {
    return <Loading>Loading settings…</Loading>;
  }

  if (!isAdmin) {
    return (
      <div>
        <Breadcrumbs items={underComp(compId, comp.name)} current="Settings" />
        <h1 className="mt-2 text-2xl font-bold">Settings</h1>
        <p className="mt-2 text-muted-foreground">
          Competition settings are for competition admins.
        </p>
      </div>
    );
  }

  if (group === undefined) {
    return <CompSettingsIndex compId={compId} comp={comp} />;
  }
  return (
    <SettingsGroupPage
      group={group as SettingsGroup}
      compId={compId}
      comp={comp}
      onSaved={() => {
        setRefresh((r) => r + 1);
        navigate(compSettingsPath(compId, comp.name));
      }}
    />
  );
}
