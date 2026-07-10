/**
 * Pilot status (safety roll call) section — React port of
 * setupPilotStatusSection(). One row per registered pilot with a
 * single-click-to-save status dropdown and an inline note input that saves
 * on blur/Enter ("one interaction, done").
 */
import { useEffect, useState } from "react";
import { Input } from "@/react/ui/input";
import type { AuthUser } from "../../auth/client";
import { api } from "../../comp/api";
import { SimpleSelect } from "./fields";
import { PILOT_STATUS_OPTIONS } from "./types";
import type { PilotListEntry, PilotStatusEntry } from "./types";

export function PilotStatusSection({
  compId,
  taskId,
  user,
  isAdmin,
  openIgcUpload,
}: {
  compId: string;
  taskId: string;
  user: AuthUser | null;
  isAdmin: boolean;
  openIgcUpload: boolean;
}) {
  const [pilots, setPilots] = useState<PilotListEntry[] | null>(null);
  const [initialByPilot, setInitialByPilot] = useState<Map<string, PilotStatusEntry>>(
    new Map()
  );
  const [marked, setMarked] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Load pilots + existing statuses in parallel
        const [pilotsRes, statusesRes] = await Promise.all([
          api.api.comp[":comp_id"].pilot.$get({ param: { comp_id: compId } }),
          api.api.comp[":comp_id"].task[":task_id"]["pilot-status"].$get({
            param: { comp_id: compId, task_id: taskId },
          }),
        ]);
        if (!pilotsRes.ok || cancelled) return;
        const pilotsData = (await pilotsRes.json()) as { pilots: PilotListEntry[] };
        const statusesData = statusesRes.ok
          ? ((await statusesRes.json()) as { statuses: PilotStatusEntry[] })
          : { statuses: [] as PilotStatusEntry[] };
        if (cancelled) return;

        const byPilot = new Map<string, PilotStatusEntry>();
        for (const s of statusesData.statuses) byPilot.set(s.comp_pilot_id, s);

        // Sort: pilots with a status first (most interesting for safety),
        // then alphabetical within each bucket.
        const sorted = pilotsData.pilots.slice().sort((a, b) => {
          const aHas = byPilot.has(a.comp_pilot_id) ? 0 : 1;
          const bHas = byPilot.has(b.comp_pilot_id) ? 0 : 1;
          if (aHas !== bHas) return aHas - bHas;
          return a.name.localeCompare(b.name);
        });

        setInitialByPilot(byPilot);
        setMarked(new Set(byPilot.keys()));
        setPilots(sorted);
      } catch {
        // Non-critical — leave the section hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, taskId]);

  // Data unavailable (comp/pilots failed to load) — leave the section hidden.
  if (pilots === null) return null;

  const hint =
    marked.size === 0 ? `${pilots.length} pilots` : `${marked.size} of ${pilots.length} marked`;

  return (
    <section>
      <h2 className="mt-8 text-lg font-bold">
        Pilot Status <span className="text-sm font-normal text-muted-foreground">{hint}</span>
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Every pilot is <strong>Present</strong> by default. Mark <strong>Absent</strong> or{" "}
        <strong>Did Not Fly</strong> as needed — uploading a track marks a pilot{" "}
        <strong>Landed</strong>. Changes save instantly and feed launch validity.
      </p>
      {pilots.length === 0 ? (
        <p className="mt-2 text-muted-foreground">No pilots registered yet</p>
      ) : (
        <ul className="mt-2 space-y-2 text-sm">
          {pilots.map((pilot) => (
            <StatusRow
              key={pilot.comp_pilot_id}
              compId={compId}
              taskId={taskId}
              pilot={pilot}
              initial={initialByPilot.get(pilot.comp_pilot_id) ?? null}
              user={user}
              isAdmin={isAdmin}
              openIgcUpload={openIgcUpload}
              onMarkedChange={(hasStatus) =>
                setMarked((prev) => {
                  const next = new Set(prev);
                  if (hasStatus) next.add(pilot.comp_pilot_id);
                  else next.delete(pilot.comp_pilot_id);
                  return next;
                })
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A single row: pilot name, status dropdown, note input. Permission logic
 * mirrors the server's `authorizeStatusMutation`: admin / self / buddy
 * (when open_igc_upload is on). Anyone without permission sees read-only
 * controls.
 */
function StatusRow({
  compId,
  taskId,
  pilot,
  initial,
  user,
  isAdmin,
  openIgcUpload,
  onMarkedChange,
}: {
  compId: string;
  taskId: string;
  pilot: PilotListEntry;
  initial: PilotStatusEntry | null;
  user: AuthUser | null;
  isAdmin: boolean;
  openIgcUpload: boolean;
  onMarkedChange: (hasStatus: boolean) => void;
}) {
  const [current, setCurrent] = useState<PilotStatusEntry | null>(initial);
  const [selectedKey, setSelectedKey] = useState(initial?.status_key ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [indicator, setIndicator] = useState("");

  const canEdit = user
    ? isAdmin ||
      pilot.linked_email === user.email ||
      // Buddy marking: rough check — the frontend doesn't know if the
      // caller is registered in this comp without an extra query. We
      // optimistically enable the controls when open_igc_upload is on; the
      // server re-validates and will reject with 403 if the caller isn't
      // registered, which we surface via the save-state UI.
      openIgcUpload
    : false;

  function flashSaved() {
    setIndicator("saved");
    setTimeout(() => {
      setIndicator((prev) => (prev === "saved" ? "" : prev));
    }, 1500);
  }

  async function saveStatusChange(newKey: string) {
    // "Landed" is derived from an active flight record (a track or a manual
    // flight), no longer hand-set (issue #306). The option only reflects
    // current state; re-selecting it is a no-op. (This section is superseded
    // by the unified task table.)
    if (newKey === "landed") {
      setSelectedKey(newKey);
      return;
    }
    setSelectedKey(newKey);
    setIndicator("saving…");
    try {
      if (newKey === "") {
        if (!current) {
          setIndicator("");
          return;
        }
        const res = await api.api.comp[":comp_id"].task[":task_id"]["pilot-status"][
          ":comp_pilot_id"
        ].$delete({
          param: { comp_id: compId, task_id: taskId, comp_pilot_id: pilot.comp_pilot_id },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        setCurrent(null);
        setNote("");
        onMarkedChange(false);
      } else {
        const res = await api.api.comp[":comp_id"].task[":task_id"]["pilot-status"][
          ":comp_pilot_id"
        ].$put({
          param: { comp_id: compId, task_id: taskId, comp_pilot_id: pilot.comp_pilot_id },
          // newKey is non-empty here (the "" → Present case took the DELETE
          // branch above); it is one of the fixed stored status keys.
          json: {
            status_key: newKey as "absent" | "dnf",
            note: note || null,
          },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as PilotStatusEntry;
        setCurrent(data);
        onMarkedChange(true);
      }
      flashSaved();
    } catch (err) {
      const code = (err as Error).message;
      setIndicator(code === "403" ? "denied" : "error");
      // Revert select to prior value
      setSelectedKey(current?.status_key ?? "");
    }
  }

  async function saveNoteChange() {
    if (!current) return;
    if ((current.note ?? "") === (note || "")) return;
    setIndicator("saving…");
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"]["pilot-status"][
        ":comp_pilot_id"
      ].$patch({
        param: { comp_id: compId, task_id: taskId, comp_pilot_id: pilot.comp_pilot_id },
        json: { note: note || null },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as PilotStatusEntry;
      setCurrent(data);
      flashSaved();
    } catch (err) {
      const code = (err as Error).message;
      setIndicator(code === "403" ? "denied" : "error");
      setNote(current?.note ?? "");
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-2">
      <strong>{pilot.name}</strong>
      {current ? (
        <span className="text-muted-foreground"> set by {current.set_by_name}</span>
      ) : null}{" "}
      <SimpleSelect
        value={selectedKey}
        onChange={(v) => void saveStatusChange(v)}
        options={PILOT_STATUS_OPTIONS.map((s) => ({ value: s.key, label: s.label }))}
        disabled={!canEdit}
        ariaLabel={`Status for ${pilot.name}`}
      />{" "}
      <Input
        className="h-7 w-auto min-w-40 flex-1"
        placeholder="Add a note…"
        maxLength={128}
        aria-label={`Note for ${pilot.name}`}
        value={note}
        disabled={!canEdit || !selectedKey}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => void saveNoteChange()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />{" "}
      <span className="text-xs text-muted-foreground">{indicator}</span>
    </li>
  );
}
