/**
 * An editor of several pages over ONE stored draft — the waypoints editor
 * (#811) and the route editor (#812). What they share, so it is decided once:
 *
 * - which draft to edit: the one in storage, or the saved state, resolved by
 *   {@link resolveStoredDraft} against what the server holds now;
 * - every change written straight through to storage (lib/draft-store.ts), so
 *   the editor's other pages, Back, Forward and a reload all find it;
 * - whether there is anything unsaved, and the guard that asks before a link
 *   leaves the editor with it (lib/use-unsaved-changes-guard.ts) — never
 *   while a save is in flight, whose result would land after a "Discard";
 * - whether the browser is keeping the draft at all ({@link DraftEditor.notKept}).
 *
 * What each editor keeps for itself is what it loads, the domain operations on
 * its draft, and what Save does — the waypoints editor stays on its list, the
 * route editor goes back to the task.
 *
 * Until 2026-11 each editor carried its own copy of this, line for line, and a
 * fix in one was a fix the other did not get.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { draftStorageKey, type DraftKey, type DraftStore } from "./draft-store";
import { useDraft } from "./use-draft";
import { useUnsavedChangesGuard } from "./use-unsaved-changes-guard";

/** How an editor reads its draft against the state the server holds. */
export interface DraftModel<T> {
  /** The content of the saved state the draft was started from. */
  base: (d: T) => string;
  /**
   * The content the draft holds now, comparable with `base`: equal to the
   * draft's own `base` while it has no edits, and to the saved state's when it
   * says what the server says.
   */
  content: (d: T) => string;
  /** The draft, its rows and ids kept, now counting as started from `base`. */
  rebase: (d: T, base: string) => T;
}

export interface DraftResolution<T> {
  draft: T;
  /** The draft came from storage (possibly rebased onto the saved state). */
  fromStorage: boolean;
  /** The saved state moved under a draft that still differs from it. */
  serverChanged: boolean;
}

/**
 * The draft to edit, given the one in storage (if any) and `fresh`, the
 * saved state as a draft.
 *
 * - Started from the saved state as it is now: the stored draft, as it is.
 * - No edits of its own: only a copy of an older save, dropped for `fresh`.
 * - Holding exactly what the server holds now: REBASED onto it, with nothing
 *   to warn about. That is a save whose answer was lost (the kit form keeps
 *   the draft when it hears nothing, and the save had landed), a second tab
 *   that saved the same edits, or another organiser making the same change.
 *   Kept as the server changed under it, the page warned that the saved copy
 *   had moved, disabled Save as having nothing to save, and offered no
 *   Discard — stuck for a day.
 * - Anything else is the organiser's work, kept, with `serverChanged`.
 */
export function resolveStoredDraft<T>(
  stored: T | null,
  fresh: T,
  model: DraftModel<T>
): DraftResolution<T> {
  if (!stored) return { draft: fresh, fromStorage: false, serverChanged: false };
  const savedBase = model.base(fresh);
  if (model.base(stored) === savedBase) {
    return { draft: stored, fromStorage: true, serverChanged: false };
  }
  const content = model.content(stored);
  if (content === model.base(stored)) {
    return { draft: fresh, fromStorage: false, serverChanged: false };
  }
  if (content === savedBase) {
    return { draft: model.rebase(stored, savedBase), fromStorage: true, serverChanged: false };
  }
  return { draft: stored, fromStorage: true, serverChanged: true };
}

export interface DraftEditor<T> {
  /** The working copy: the stored draft, or the saved state. */
  draft: T;
  /**
   * The draft has been read from storage (or found absent). Until then
   * `draft` is the saved state, and a page addressing a row that exists only
   * in the draft must wait rather than call it missing.
   */
  ready: boolean;
  /** The working copy differs from the saved state. */
  dirty: boolean;
  /** The saved state changed after this draft was started (see resolveStoredDraft). */
  serverChanged: boolean;
  /**
   * The browser refused to store the draft (site data blocked, or full): it
   * is kept in this tab's memory, so the editor's other pages still find it,
   * but a reload will not.
   */
  notKept: boolean;
  /** Change the draft; the change is in storage before this returns. */
  update: (change: (d: T) => T) => void;
  /**
   * Change the draft in storage only, for a page on its way out: it stays as
   * it is on screen until it has gone, rather than flash the state the change
   * leaves it in. The next page reads the change when it mounts.
   */
  updateOnLeave: (change: (d: T) => T) => void;
  /**
   * Forget the draft: back to the saved state — `next` when the caller knows
   * the saved state has just changed (a save that landed).
   */
  discard: (next?: T) => void;
  /**
   * Forget the stored draft only, for a page on its way out (a save that
   * leaves): it stays as it is on screen until it has gone.
   */
  forget: () => void;
  /**
   * A save is in flight (the kit form's `onPendingChange`): the guard stands
   * down, since a "Discard" now would not stop the save from landing.
   */
  setSaving: (saving: boolean) => void;
}

export function useDraftEditor<T>({
  store,
  draftKey,
  owner,
  enabled,
  fresh,
  model,
  guard,
}: {
  store: DraftStore<T>;
  /** What the draft edits: `[bareCompId]`, `[bareCompId, taskId]`. */
  draftKey: DraftKey;
  /** The signed-in user's id, or null while the session loads. */
  owner: string | null;
  /**
   * The viewer edits here — an organiser, on a mounted page (the server has
   * no storage, and a first render that differed from its markup would not
   * hydrate), with the saved state loaded.
   */
  enabled: boolean;
  /** The saved state as a draft. Memoise it: a new one each render is a new draft. */
  fresh: T;
  /** A module-level constant. */
  model: DraftModel<T>;
  /** The question asked before a link leaves the editor with unsaved edits. */
  guard: { title: string; message: string; isWithin: (url: URL) => boolean };
}): DraftEditor<T> {
  const on = enabled && owner !== null;
  const stored = useDraft(store, on ? draftKey : null, on ? owner : null);
  const resolved = useMemo(
    () => resolveStoredDraft(stored.draft, fresh, model),
    [stored.draft, fresh, model]
  );

  // One string for "which draft", so a new key array each render is not a
  // new draft to an effect.
  const keyId = draftStorageKey(store.kind, draftKey);
  const keyRef = useRef(draftKey);
  keyRef.current = draftKey;

  // A stored draft resolveStoredDraft passed over (an unedited copy of an
  // older save) is never going to be read: it does not stay.
  const passedOver = stored.draft !== null && !resolved.fromStorage;
  useEffect(() => {
    if (passedOver) store.clear(keyRef.current);
  }, [passedOver, keyId, store]);

  // The latest working copy, so two changes in one event both land.
  const latest = useRef(resolved.draft);
  latest.current = resolved.draft;

  const dirty = on && model.content(resolved.draft) !== model.base(fresh);
  const [saving, setSaving] = useState(false);
  // Refused once in this page's life, or held only in memory by an earlier
  // page of the editor.
  const [refused, setRefused] = useState(false);
  const notKept = on && (refused || store.heldInMemory(draftKey));

  useUnsavedChangesGuard(dirty && !saving, {
    ...guard,
    onDiscard: () => store.clear(keyRef.current),
  });

  return {
    draft: resolved.draft,
    ready: on,
    dirty,
    serverChanged: resolved.serverChanged,
    notKept,
    update(change) {
      const next = change(latest.current);
      if (next === latest.current) return;
      latest.current = next;
      if (!stored.setDraft(next)) setRefused(true);
    },
    updateOnLeave(change) {
      if (!on || owner === null) return;
      store.save(draftKey, owner, change(latest.current));
    },
    discard(next) {
      stored.clearDraft();
      latest.current = next ?? fresh;
    },
    forget() {
      store.clear(draftKey);
    },
    setSaving,
  };
}
