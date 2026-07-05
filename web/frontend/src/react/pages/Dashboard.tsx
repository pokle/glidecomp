/**
 * My Flights dashboard — React port of dashboard.ts / dashboard.html.
 * Local IGC/XCTSK library backed by the same IndexedDB storage module the
 * (vanilla, imperative-map) analysis page uses.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
import { deleteAccount } from "../../auth/client";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { signInWithGoogle, useUser } from "../lib/user";
import { downloadFile, relativeTime } from "../lib/format";

// Mirrors the server-side limits in
// web/workers/competition-api/src/routes/user-files.ts (MAX_USER_*).
const MAX_USER_TRACKS = 500;
const MAX_USER_TASKS = 200;
const MAX_USER_BYTES = 200 * 1024 * 1024;

export function Dashboard() {
  const { username } = useParams<{ username: string }>();
  const { user, loading } = useUser();
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [tracks, setTracks] = useState<StoredTrack[]>([]);
  const [tasks, setTasks] = useState<StoredTask[]>([]);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<"tracks" | "tasks">("tracks");
  const [dragOver, setDragOver] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const refreshLists = useCallback(async () => {
    const [nextTracks, nextTasks] = await Promise.all([storage.listTracks(), storage.listTasks()]);
    setTracks(nextTracks);
    setTasks(nextTasks);
  }, []);

  // Auth guards mirror the vanilla dashboard: anonymous → sign-in redirect,
  // no username → onboarding, /u/me → the user's own page.
  useEffect(() => {
    document.title = "GlideComp - Dashboard";
    if (loading) return;
    if (!user) {
      signInWithGoogle();
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
  }, [user, loading, username, navigate, refreshLists]);

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

  if (!ready) return <p role="status">Loading…</p>;

  async function handleDeleteAccount() {
    const confirmed = await confirm({
      title: "Delete Account",
      message:
        "This will permanently delete your account and all associated data. This action cannot be undone.",
      confirmLabel: "Delete my account",
      destructive: true,
    });
    if (!confirmed) return;
    setDeleting(true);
    const result = await deleteAccount();
    if (result.success) {
      localStorage.clear();
      storage.close();
      indexedDB.deleteDatabase("glidecomp");
      window.location.href = "/react/";
    } else {
      setDeleting(false);
      toast.error(result.error || "Failed to delete account. Please try again.");
    }
  }

  return (
    <section>
      <h1 className="text-2xl font-bold">My Flights</h1>
      <p className="text-muted-foreground">Upload and manage your IGC tracks and tasks</p>

      <p role="status" aria-live="polite" className="mt-4 rounded-lg border bg-muted/50 px-3 py-2 text-sm">
        <strong>Heads up.</strong> Files you upload here are visible to anyone with a link. Share
        the link to your flight if you want others to see it.
      </p>

      <StorageUsage tracks={tracks} tasks={tasks} />

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as "tracks" | "tasks")}
        className="mt-6"
      >
        <TabsList>
          <TabsTrigger value="tracks">
            Tracks {tracks.length > 0 ? `(${tracks.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="tasks">
            Tasks {tasks.length > 0 ? `(${tasks.length})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tracks">
          <UploadZone accept=".igc" hint=".igc" onFiles={handleFiles} />
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
        </TabsContent>

        <TabsContent value="tasks">
          <UploadZone accept=".xctsk" hint=".xctsk" onFiles={handleFiles} />
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
        </TabsContent>
      </Tabs>

      {dragOver ? (
        <div
          role="status"
          className="pointer-events-none fixed inset-0 z-20 flex flex-col items-center justify-center gap-1 border-2 border-dashed border-primary bg-background/90 font-bold"
        >
          <p>Drop files to upload</p>
          <p className="text-sm font-normal text-muted-foreground">.igc and .xctsk files</p>
        </div>
      ) : null}

      <section className="mt-10">
        <h2 className="text-lg font-bold">Danger zone</h2>
        <Button
          type="button"
          variant="destructive"
          className="mt-2"
          disabled={deleting}
          onClick={handleDeleteAccount}
        >
          {deleting ? "Deleting..." : "Delete account"}
        </Button>
      </section>
    </section>
  );
}

function UploadZone({
  accept,
  hint,
  onFiles,
}: {
  accept: string;
  hint: string;
  onFiles: (files: FileList) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <label className="mt-3 block cursor-pointer rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground transition-colors select-none hover:bg-muted hover:text-foreground">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        className="sr-only"
        onChange={async (e) => {
          if (e.target.files?.length) {
            await onFiles(e.target.files);
            if (inputRef.current) inputRef.current.value = "";
          }
        }}
      />
      Drop <strong>{hint}</strong> files here or click to browse
    </label>
  );
}

function StorageUsage({ tracks, tasks }: { tracks: StoredTrack[]; tasks: StoredTask[] }) {
  if (tracks.length === 0 && tasks.length === 0) return null;

  const usedBytes = tracks.reduce((sum, t) => sum + (t.fileSize ?? t.content?.length ?? 0), 0);
  const usedMB = usedBytes / (1024 * 1024);
  const limitMB = MAX_USER_BYTES / (1024 * 1024);
  // The byte quota is the one users hit in practice; counts only matter
  // near their (high) limits, so mention them only when relevant.
  const fraction = Math.max(
    usedBytes / MAX_USER_BYTES,
    tracks.length / MAX_USER_TRACKS,
    tasks.length / MAX_USER_TASKS
  );
  const parts = [`${usedMB < 10 ? usedMB.toFixed(1) : Math.round(usedMB)} of ${limitMB} MB`];
  if (tracks.length / MAX_USER_TRACKS >= 0.8)
    parts.push(`${tracks.length} of ${MAX_USER_TRACKS} tracks`);
  if (tasks.length / MAX_USER_TASKS >= 0.8) parts.push(`${tasks.length} of ${MAX_USER_TASKS} tasks`);

  return (
    <Progress value={Math.min(100, Math.max(1, fraction * 100))} className="mt-4 max-w-60">
      <ProgressLabel>Storage</ProgressLabel>
      <ProgressValue className="ml-auto">{() => parts.join(" · ")}</ProgressValue>
    </Progress>
  );
}
