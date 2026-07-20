/**
 * My Flights dashboard — React port of dashboard.ts / dashboard.html.
 * Local IGC/XCTSK library backed by the same IndexedDB storage module the
 * (vanilla, imperative-map) analysis page uses.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/react/ui/tabs";
import { Progress, ProgressLabel, ProgressValue } from "@/react/ui/progress";
import { Button } from "@/react/ui/button";
import { parseIGC, parseXCTask } from "@glidecomp/engine";
import {
  storage,
  QuotaExceededError,
  type StoredTask,
  type StoredTrack,
} from "../../analysis/storage";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { goToSignIn, useUser } from "../lib/user";
import { downloadFile, formatTaskDate, ordinal, relativeTime } from "../lib/format";
import { api } from "../../comp/api";

// Mirrors the server-side limits in
// web/workers/competition-api/src/routes/user-files.ts (MAX_USER_*).
const MAX_USER_TRACKS = 500;
const MAX_USER_TASKS = 200;
const MAX_USER_BYTES = 200 * 1024 * 1024;

export function Dashboard() {
  const { username } = useParams<{ username: string }>();
  const { user, loading, previewingSignedOut } = useUser();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [tracks, setTracks] = useState<StoredTrack[]>([]);
  const [tasks, setTasks] = useState<StoredTask[]>([]);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<"tracks" | "tasks">("tracks");
  const [dragOver, setDragOver] = useState(false);

  const refreshLists = useCallback(async () => {
    const [nextTracks, nextTasks] = await Promise.all([storage.listTracks(), storage.listTasks()]);
    setTracks(nextTracks);
    setTasks(nextTasks);
  }, []);

  // Auth guards mirror the vanilla dashboard: anonymous → sign-in redirect,
  // no username → onboarding, /u/me → the user's own page. A superadmin
  // previewing the signed-out view gets the sign-in card instead of OAuth.
  useEffect(() => {
    document.title = "GlideComp - My Flights";
    if (loading) return;
    if (!user) {
      if (!previewingSignedOut) goToSignIn(window.location.pathname);
      return;
    }
    if (!user.username) {
      navigate("/onboarding", { replace: true });
      return;
    }
    if (username === "me") {
      navigate(`/u/${user.username}`, { replace: true });
      return;
    }
    (async () => {
      await storage.init();
      await refreshLists();
      setReady(true);
    })();
  }, [user, loading, previewingSignedOut, username, navigate, refreshLists]);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      let addedTracks = false;
      let addedTasks = false;

      for (const file of files) {
        const name = file.name.toLowerCase();
        try {
          if (name.endsWith(".igc")) {
            const content = await file.text();
            const igcFile = parseIGC(content);
            await storage.storeTrack(file.name, content, igcFile);
            addedTracks = true;
          } else if (name.endsWith(".xctsk")) {
            const content = await file.text();
            const task = parseXCTask(content);
            const code = file.name.replace(/\.xctsk$/i, "").toLowerCase().replace(/\s+/g, "-");
            await storage.storeTask(code, task, content);
            addedTasks = true;
          }
        } catch (err) {
          // Quota errors aren't parse errors — a modal stops the user dead,
          // which matches the severity ("delete something to upload more").
          if (err instanceof QuotaExceededError) {
            await confirm({ title: "Storage quota exceeded", message: err.message, alert: true });
            break;
          }
          console.error(`Failed to parse ${file.name}:`, err);
          toast.error(
            `Could not read ${file.name} — is it a valid ${name.endsWith(".xctsk") ? "XCTask" : "IGC"} file?`
          );
        }
      }

      if (addedTracks || addedTasks) {
        await refreshLists();
        if (addedTasks && !addedTracks) setTab("tasks");
      }
    },
    [confirm, refreshLists]
  );

  // Full-page drag and drop.
  useEffect(() => {
    if (!ready) return;
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = e.dataTransfer?.files;
      if (files?.length) void handleFiles(files);
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
    };
  }, [ready, handleFiles]);

  if (!user && previewingSignedOut) {
    return (
      <section className="mx-auto max-w-md rounded-xl border px-6 py-10 text-center">
        <h1 className="text-xl font-bold">Sign in to see your flights</h1>
        <p className="mt-2 text-muted-foreground">
          Your IGC track logs and tasks live in your account.
        </p>
        <Button type="button" className="mt-4" onClick={() => goToSignIn(window.location.pathname)}>
          Sign in
        </Button>
      </section>
    );
  }

  if (!ready) return <p role="status">Loading…</p>;

  return (
    <section>
      <NearQuotaWarning tracks={tracks} tasks={tasks} />

      <CompetitionFlightsSection />

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as "tracks" | "tasks")}
      >
        {/* No page header here, so the add-files action rides the tab row,
            right-aligned like the section actions on the comp/task pages. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <TabsList>
            <TabsTrigger value="tracks">
              Tracks {tracks.length > 0 ? `(${tracks.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="tasks">
              Tasks {tasks.length > 0 ? `(${tasks.length})` : ""}
            </TabsTrigger>
          </TabsList>
          <div className="ml-auto">
            {tab === "tracks" ? (
              <AddFilesButton accept=".igc" label="Add .igc track log" onFiles={handleFiles} />
            ) : (
              <AddFilesButton accept=".xctsk" label="Add .xctsk task" onFiles={handleFiles} />
            )}
          </div>
        </div>

        <TabsContent value="tracks">
          {tracks.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              <p className="font-medium">No flight tracks yet</p>
              <p className="text-sm">Upload IGC files or open tracks in the analysis page</p>
            </div>
          ) : (
            <ul className="mt-3 divide-y rounded-lg border">
              {tracks.map((track) => (
                <li key={track.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <a
                    href={`/analysis.html?storedTrack=${encodeURIComponent(track.id)}`}
                    className="font-medium underline underline-offset-4"
                  >
                    {track.name}
                  </a>
                  <span className="text-sm text-muted-foreground">
                    {[track.summary.glider, track.filename].filter(Boolean).join(" · ")}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {relativeTime(track.lastAccessedAt)}
                  </span>
                  <span className="ml-auto flex gap-2">
                    <Button nativeButton={false}
                      variant="outline"
                      size="sm"
                      title="View on the analysis map"
                      render={
                        <a href={`/analysis.html?storedTrack=${encodeURIComponent(track.id)}`} />
                      }
                    >
                      View
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      title="Download IGC"
                      onClick={async () => {
                        const stored = await storage.getTrack(track.id);
                        if (stored)
                          downloadFile(stored.filename, stored.content, "application/octet-stream");
                      }}
                    >
                      Download
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      title="Remove track"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Remove this flight?",
                          message: `${track.name} will be deleted from your storage. Tracks already submitted to a competition stay with the competition.`,
                          confirmLabel: "Remove",
                          destructive: true,
                        });
                        if (!ok) return;
                        await storage.deleteTrack(track.id);
                        await refreshLists();
                      }}
                    >
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm text-muted-foreground">
            You can also drag and drop .igc files anywhere on this page.
          </p>
        </TabsContent>

        <TabsContent value="tasks">
          {tasks.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              <p className="font-medium">No competition tasks yet</p>
              <p className="text-sm">Upload XCTSK files or load tasks in the analysis page</p>
            </div>
          ) : (
            <ul className="mt-3 divide-y rounded-lg border">
              {tasks.map((task) => (
                <li key={task.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <a
                    href={`/analysis.html?storedTask=${encodeURIComponent(task.id)}`}
                    className="font-medium underline underline-offset-4"
                  >
                    {task.name}
                  </a>
                  <span className="text-sm text-muted-foreground">
                    {task.task.turnpoints.length} turnpoint
                    {task.task.turnpoints.length !== 1 ? "s" : ""} · {task.id}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {relativeTime(task.lastAccessedAt)}
                  </span>
                  <span className="ml-auto flex gap-2">
                    <Button nativeButton={false}
                      variant="outline"
                      size="sm"
                      title="View on the analysis map"
                      render={
                        <a href={`/analysis.html?storedTask=${encodeURIComponent(task.id)}`} />
                      }
                    >
                      View
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      title="Download XCTSK"
                      onClick={async () => {
                        const stored = await storage.getTask(task.id);
                        if (stored)
                          downloadFile(`${stored.id}.xctsk`, stored.rawJson, "application/xctsk+json");
                      }}
                    >
                      Download
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      title="Remove task"
                      onClick={async () => {
                        const ok = await confirm({
                          title: "Remove this task?",
                          message: `${task.name} will be deleted from your storage.`,
                          confirmLabel: "Remove",
                          destructive: true,
                        });
                        if (!ok) return;
                        await storage.deleteTask(task.id);
                        await refreshLists();
                      }}
                    >
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm text-muted-foreground">
            You can also drag and drop .xctsk files anywhere on this page.
          </p>
        </TabsContent>
      </Tabs>

      <StorageSection tracks={tracks} tasks={tasks} />

      {dragOver ? (
        <div
          role="status"
          className="pointer-events-none fixed inset-0 z-20 flex flex-col items-center justify-center gap-1 border-2 border-dashed border-primary bg-background/90 font-bold"
        >
          <p>Drop files to upload</p>
          <p className="text-sm font-normal text-muted-foreground">.igc and .xctsk files</p>
        </div>
      ) : null}
    </section>
  );
}

type CompFlight = Awaited<
  ReturnType<Awaited<ReturnType<typeof api.api.comp.pilot.flights.$get>>["json"]>
>["flights"][number];

/**
 * Flights linked to the signed-in pilot's competition registrations, fetched
 * from the competition API (unlike the local library below). These belong to
 * the competition — no remove button; rows link out to the comp, the task,
 * and (once scored) the pilot's score detail page. Renders nothing until the
 * pilot has at least one competition flight.
 */
function CompetitionFlightsSection() {
  const [flights, setFlights] = useState<CompFlight[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.api.comp.pilot.flights.$get();
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setFlights(data.flights);
      } catch {
        // Network hiccup — the section just stays hidden; the local library
        // below is unaffected.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (flights.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="text-lg font-bold">Competition flights</h2>
      <ul className="mt-3 divide-y rounded-lg border">
        {flights.map((f) => (
          <li
            key={`${f.task_id}:${f.comp_pilot_id}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
          >
            <Link
              to={`/comp/${f.comp_id}/task/${f.task_id}`}
              className="font-medium underline underline-offset-4"
            >
              {f.task_name}
            </Link>
            <span className="text-sm text-muted-foreground">
              <Link to={`/comp/${f.comp_id}`} className="underline underline-offset-4">
                {f.comp_name}
              </Link>
            </span>
            <span className="text-sm text-muted-foreground">
              {formatTaskDate(f.task_date, { year: "numeric", month: "short", day: "numeric" })}
              {f.kind === "manual" ? " · manual flight report" : ""}
            </span>
            <span className="ml-auto text-sm">
              {f.rank != null ? (
                <Link
                  to={`/comp/${f.comp_id}/task/${f.task_id}/pilot/${f.comp_pilot_id}`}
                  className="font-medium underline underline-offset-4"
                  title={`View this flight's score (${f.pilot_class} class)`}
                >
                  {ordinal(f.rank)} of {f.class_size}
                </Link>
              ) : (
                <span className="text-muted-foreground">Not scored yet</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-muted-foreground">
        These flights are part of their competition&rsquo;s record and are managed by the
        competition, so they can&rsquo;t be removed here.
      </p>
    </section>
  );
}

/** "Add …" button on the tab row; the drag-and-drop hint lives below each list. */
function AddFilesButton({
  accept,
  label,
  onFiles,
}: {
  accept: string;
  label: string;
  onFiles: (files: FileList) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        hidden
        onChange={async (e) => {
          if (e.target.files?.length) {
            await onFiles(e.target.files);
            if (inputRef.current) inputRef.current.value = "";
          }
        }}
      />
      <Button type="button" onClick={() => inputRef.current?.click()}>
        {label}
      </Button>
    </>
  );
}

function storageFraction(tracks: StoredTrack[], tasks: StoredTask[]) {
  const usedBytes = tracks.reduce((sum, t) => sum + (t.fileSize ?? t.content?.length ?? 0), 0);
  return {
    usedBytes,
    fraction: Math.max(
      usedBytes / MAX_USER_BYTES,
      tracks.length / MAX_USER_TRACKS,
      tasks.length / MAX_USER_TASKS
    ),
  };
}

/**
 * The Storage section lives at the bottom of the page; this banner surfaces
 * at the top once usage passes 80% so uploads don't fail by surprise.
 */
function NearQuotaWarning({ tracks, tasks }: { tracks: StoredTrack[]; tasks: StoredTask[] }) {
  const { fraction } = storageFraction(tracks, tasks);
  if (fraction < 0.8) return null;
  return (
    <p
      role="status"
      className="mb-4 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <strong>Storage almost full</strong> — {Math.round(fraction * 100)}% used. Remove old
      flights below or new uploads will fail.
    </p>
  );
}

function StorageSection({ tracks, tasks }: { tracks: StoredTrack[]; tasks: StoredTask[] }) {
  const { usedBytes, fraction } = storageFraction(tracks, tasks);
  const usedMB = usedBytes / (1024 * 1024);
  const limitMB = MAX_USER_BYTES / (1024 * 1024);
  // The byte quota is the one users hit in practice; counts only matter
  // near their (high) limits, so mention them only when relevant.
  const parts = [`${usedMB < 10 ? usedMB.toFixed(1) : Math.round(usedMB)} of ${limitMB} MB`];
  if (tracks.length / MAX_USER_TRACKS >= 0.8)
    parts.push(`${tracks.length} of ${MAX_USER_TRACKS} tracks`);
  if (tasks.length / MAX_USER_TASKS >= 0.8) parts.push(`${tasks.length} of ${MAX_USER_TASKS} tasks`);

  return (
    <section className="mt-10">
      <h2 className="text-lg font-bold">Storage</h2>
      {tracks.length > 0 || tasks.length > 0 ? (
        <Progress value={Math.min(100, Math.max(1, fraction * 100))} className="mt-2 max-w-60">
          <ProgressLabel className="sr-only">Storage</ProgressLabel>
          <ProgressValue className="ml-auto">{() => parts.join(" · ")}</ProgressValue>
        </Progress>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">Nothing stored yet.</p>
      )}
      <p className="mt-3 text-sm text-muted-foreground">
        <strong>Heads up.</strong> Files you upload here are visible to anyone with a link. Share
        the link to your flight if you want others to see it.
      </p>
    </section>
  );
}
