/**
 * A draft (lib/draft-store.ts) as React state: read from storage when the
 * page knows whose draft and of what, written through to storage on every
 * change, and forgotten on save or discard.
 *
 * Storage is the source of truth between pages, the state only within one:
 * a second page reading the same draft (a waypoint's page and the list it
 * came from, in #811) each load it when they mount, so whatever one wrote is
 * what the other reads.
 */
import { useState } from "react";
import { draftStorageKey, type DraftKey, type DraftStore } from "./draft-store";

export interface DraftState<T> {
  /** The draft, or null: none yet, or none that could be read. */
  draft: T | null;
  /**
   * Replace the draft. False when storage refused it: the page still has it,
   * but a reload will not.
   */
  setDraft: (value: T) => boolean;
  /** Forget it: saved, discarded, or starting again. */
  clearDraft: () => void;
}

/**
 * `key` and `owner` are null until the page knows them (the comp and the
 * signed-in user are still loading); the draft reads as null until then.
 */
export function useDraft<T>(
  store: DraftStore<T>,
  key: DraftKey | null,
  owner: string | null
): DraftState<T> {
  // One string for "which draft", so a new key array each render is not a
  // new draft.
  const id = key && owner ? `${owner}\n${draftStorageKey(store.kind, key)}` : null;
  const [held, setHeld] = useState(() => ({
    id,
    value: key && owner ? store.load(key, owner) : null,
  }));

  // The page came to know whose draft it is (or moved to another one): read
  // it now, during this render, rather than show a frame without it.
  let current = held;
  if (held.id !== id) {
    current = { id, value: key && owner ? store.load(key, owner) : null };
    setHeld(current);
  }

  return {
    draft: current.value,
    setDraft(value) {
      if (!key || !owner) return false;
      const kept = store.save(key, owner, value);
      setHeld({ id, value });
      return kept;
    },
    clearDraft() {
      if (key) store.clear(key);
      setHeld({ id, value: null });
    },
  };
}
