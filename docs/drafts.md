# Drafts that survive navigation

Decided in [#810](https://github.com/pokle/glidecomp/issues/810), for
[#811](https://github.com/pokle/glidecomp/issues/811) and
[#812](https://github.com/pokle/glidecomp/issues/812) to reuse
(tracking: [#823](https://github.com/pokle/glidecomp/issues/823)).

Code: `web/frontend/src/react/lib/draft-store.ts` (the store),
`lib/use-draft.ts` (the React hook), and the three editors that use it: the
roster import (`pages/CompRosterImportPage.tsx`, #810), the waypoints
editor (`comp/waypoints-draft.ts` + `comp/use-waypoints-editor.ts`, #811 — see
[How the waypoints editor uses it](#how-the-waypoints-editor-uses-it)) and the
route editor (`comp/route-draft.ts` + `comp/use-route-editor.ts`, #812 — see
[How the route editor uses it](#how-the-route-editor-uses-it)).

## The problem

The overlays rule in CLAUDE.md makes every editor a page with its own URL. A
page must not be handed state in memory by the page underneath it, because a
reload or a link opened in another tab does not have that page underneath.
Most pages fetch what they need from the server.

A **draft** cannot be fetched, because the server does not have it yet:

- the roster import (#810): a CSV file that the browser read, which the
  organiser reviews before anything is written;
- the waypoints editor (#811): a whole waypoint file, edited across the list
  and each waypoint's page, then saved as a set;
- the route editor (#812): a task route, edited across the route and each
  turnpoint's page, then saved as a set.

So the browser keeps the draft, in a place that a reload, Back and Forward can
find again.

## The decision

**Keep each draft in the tab's `sessionStorage`. Key it by what it edits. Mark
it with the signed-in user, version it, and let every read come back empty.**

```ts
// Once per kind of draft, beside the editor that owns it:
export const rosterImportDraft = defineDraft<RosterImportDraft>({
  kind: "roster-import",   // part of the storage key
  version: 1,              // increase it when RosterImportDraft changes shape
  isValid: (v): v is RosterImportDraft => /* optional deep check */,
  // maxAgeMs: one day by default
});

// In a page:
const { draft, setDraft, clearDraft } = useDraft(
  rosterImportDraft,
  comp ? [comp.comp_id] : null,   // the key: null while it is not known
  user ? user.id : null           // the owner: null while it is not known
);

// Outside React (a menu action that starts again, a save handler):
rosterImportDraft.load([compId], userId);  // T | null
rosterImportDraft.save([compId], userId, value);  // false if storage refused it
rosterImportDraft.clear([compId]);
clearAllDrafts();  // signOut() calls this
```

The key is an array, from the most general part to the most specific:
`[compId]` for a roster or a waypoint file, `[compId, taskId]` for a route.
Use the comp's bare id (`comp.comp_id`, or `bareCompId()` on an id from a
URL), never an id with a hidden comp's share key in it.

## What was weighed

### Where to keep it

| | sessionStorage | localStorage | IndexedDB | history state |
|---|---|---|---|---|
| Survives a reload | yes | yes | yes | yes |
| Scope | one tab | every tab | every tab | one history entry |
| Survives closing the tab | no | yes | yes | no |
| Read | synchronous | synchronous | asynchronous | synchronous |
| Size | about 5 MB | about 5 MB | hundreds of MB | browser-dependent, small in some |

- **sessionStorage** was chosen.
  - Two tabs have two drafts that never overwrite each other.
  - Closing the tab removes its drafts, so a draft cannot wait on a shared
    computer for the next person.
  - A synchronous read lets a page render its draft on the first frame,
    without a loading state.
  - The space is ample. A 30-pilot roster CSV is about 3 KB. A
    150-waypoint file in JSON is about 30 KB. Even 10,000 waypoints is
    under 2 MB.
- **localStorage** is shared by every tab and is kept after the browser
  closes. Two tabs editing one comp would overwrite each other's draft. A
  hidden comp's roster would stay on the computer until somebody cleared it.
- **IndexedDB** has the same sharing and persistence problems, and its reads
  are asynchronous, so every page would need a loading state. Its extra space
  is not needed.
- **History state** (`navigate(path, { state })`) belongs to one history
  entry. This is satisfactory for the import, but it does not work for #811
  or #812. In those editors, the waypoint page edits the draft and Back goes
  to the list entry, which still holds the old copy.

### A draft id in the URL, or a key from what it edits

The key comes from what the draft edits, so there is no draft id in the URL.

- One draft for each thing edited is the model the editors need. The list and
  each waypoint's page are different URLs that edit the same waypoint file.
  With a draft id, every link between them would have to carry the id.
- A draft id in a URL that somebody shares would point at a draft the other
  person cannot have.
- The disadvantage: one tab has only one roster import at a time. If the
  organiser goes Back and starts another import, the new file replaces the
  first. This is what the organiser asked for.

### What can make a read come back empty

A draft can be missing, and every page that reads one must show something
sensible when it is. A read is empty when:

- the draft was never saved in this tab, for example in a link opened in a
  new tab or another browser (Chrome and Safari do not copy sessionStorage
  into a tab opened with `noopener`);
- the draft was applied, discarded, or replaced;
- another account saved it. The store deletes it and does not show it.
- the draft has a different `version`, for example a tab that was open
  during a deploy that changed the shape. The store deletes it.
- the draft is older than `maxAgeMs` (one day by default), for example a tab
  that the browser restored a week later. The store deletes it.
- the stored value fails `isValid`, or is not JSON. The store deletes it.
- storage is blocked or full. Then `save` returns `false`, and the page
  keeps the draft in memory only for as long as it is open.

**The roster import shows its first step.** It asks for the file again, with
no error message: nothing is wrong, the file is simply not chosen yet. An
editor whose draft is a copy of saved data (#811, #812) can start again from
the saved data, which it fetches anyway.

### Hidden comps and other accounts

A draft can contain data from a hidden (`test`) comp, for example its roster
read from a CSV. So:

- every draft records the user id that saved it, and the store gives it to
  no other user;
- `signOut()` (`auth/client.ts`) calls `clearAllDrafts()`;
- sessionStorage is removed when the tab closes.

### When to clear a draft

- **Applied (saved):** clear it. The roster import clears only the stored copy
  before it leaves the page, so the review stays on screen until the page
  changes.
- **Cancelled:** clear it.
- **Back:** do not clear it. Back means "not now". Forward, or opening the page
  again, finds the draft.
- **Starting again on purpose** (the pilots menu's "Import CSV…"): clear it
  before navigating, so the page starts at its first step.

## Notes for #811 and #812

- **Store what you cannot fetch, and plan again from what you can.** The
  roster import stores the FILE (`{ fileName, text }`), not the review. The
  page makes the review again from the file and the roster that it fetches,
  so the review always shows the roster as it is now. A waypoint or route
  draft could also store the server version it started from, so that the
  editor can see when the saved data changed during the edit.
- **Storage is the source of truth between pages.** Each page reads the
  draft when it mounts (`useDraft`) and writes each change to storage.
- **Increase `version` whenever the stored type changes.** A draft that the
  old code wrote is then deleted, not read as the new type.
- **The unsaved-changes guard** (`lib/use-unsaved-changes-guard.ts`) asks
  before a page with an unsaved FORM is left. A stored draft survives a
  reload, so a page that holds one does not need the guard for reloads.

## How the waypoints editor uses it

[#811](https://github.com/pokle/glidecomp/issues/811) made the waypoints
editor five pages over one draft: the list (`/comp/:id/waypoints`), one
waypoint (`/waypoints/:n`), Add waypoint (`/waypoints/new`), the map at full
size (`/waypoints/map`) and the altitude review (`/waypoints/altitudes`, and
`/altitudes/:n` for one waypoint of it). The store is `waypointsDraft` in
`comp/waypoints-draft.ts`, keyed `[compId]`; every page reaches it through
`useWaypointsEditor()` (`comp/use-waypoints-editor.ts`). What it decided, for
#812 to reuse or argue with:

- **A whole-file draft, not a save per item.** The server holds the waypoint
  set as one document, saved with one `PUT` and one audit entry, and the
  editor's biggest changes are set-wide (upload a file, convert from feet,
  take the map's altitude for all). A save per waypoint would be a
  read-modify-write of the whole set on every tap. The pilot page saves per
  pilot because a pilot IS a row on the server.
- **Items are addressed by the draft's own ids.** A waypoint's page is
  `/waypoints/:n`, where `n` is the row id in the draft — not the code, which
  that page edits, and which a waypoint added a minute ago has nowhere else.
  With no draft, the rows are numbered 1..N in file order, the same on every
  page and after every reload; a draft keeps the ids it was given, and a new
  row or a replaced file takes ids never used before.
- **Every change is written at once.** A page has no draft of its own inside
  the draft: a waypoint's page writes each keystroke through, so Done and Back
  both keep it and a reload finds it. (The sheets each held a local copy,
  applied on the way out — which a page's way out, the browser's Back, would
  lose.)
- **Where the server's copy came from.** The draft stores `base`, the saved
  set it started from. A stored draft with no edits of its own is only a copy
  of an older save, so when the server's set has moved it is dropped for the
  new one; a draft WITH edits is kept, and the list says the saved set changed
  under it (`resolveDraft`).
- **Review state is part of the draft.** The altitude review's readings and
  its list's membership and order are a snapshot taken when the check runs,
  stored with the file, so going into one waypoint of the review and back, or
  reloading, finds the same list.
- **Read only after mount.** The list is server-rendered, and the server has
  no storage: a first client render that read the draft would not match the
  server's markup. `useMounted()` holds the read back one render.
- **Leaving.** Going between the editor's own pages is not leaving it, so the
  unsaved-changes guard is told which links are inside (`isWithin`). A link
  out asks "Discard changes?", and discarding clears the draft (`onDiscard`).
  Back does not ask — nothing in the app asks on Back since #817 — and here
  it means "not now": the draft waits. A reload keeps the draft too, so the
  list has a "Discard changes" button beside Save for throwing it away on
  purpose. Save clears it.

## How the route editor uses it

[#812](https://github.com/pokle/glidecomp/issues/812) made the route editor
five pages over one draft: the route (`/comp/:c/task/:t/route`), one
turnpoint (`/route/:n`), Quick entry (`/route/quick`), Load from XContest
(`/route/xcontest`) and Add waypoint (`/route/add-waypoint`). The store is
`routeDraft` in `comp/route-draft.ts`, keyed `[compId, taskId]` (the comp's
bare id); every page reaches it through `useRouteEditor()`
(`comp/use-route-editor.ts`). It follows the waypoints editor in every point
above. What is particular to a route:

- **The draft is the whole task, not only the turnpoints.** The start and
  goal settings are in it too, because they are edited on two pages (the
  route's Start and Goal sections, and the start and goal turnpoints' own
  pages), and so is the task the route was loaded from (`baseTask`): an
  imported `.xctsk` or XContest task brings fields the editor does not edit,
  and Save must still write them.
- **Times are stored as the organiser types them**, in the competition's zone.
  They become UTC only when Save assembles the task (`assembleRouteTask` in
  `comp/route-editor.ts`, the same assembly the MCP route plan uses).
- **Turnpoints are addressed by the draft's own ids** (`/route/:n`), as
  waypoints are. A reorder, a delete or Quick entry keeps the id of every
  turnpoint that is still there (Quick entry reconciles, see
  `comp/route-reconcile.ts`); a loaded task's rows take ids never used before.
- **"Add turnpoint" adds an empty turnpoint and opens its page.** Every change
  on that page goes straight into the draft, like an edit. An empty
  turnpoint (no code and no coordinates) is not an edit — the dirty check
  ignores it — and the route page drops it when it opens again, so an Add
  that is left empty, by Done or by Back, adds nothing. A new Goal demotes
  the old one at its first edit, not at the press.
- **Waypoints made on Add waypoint wait in the draft** (`pendingWaypoints`).
  They are in the route at once, and Save writes them to the competition just
  before the route, so discarding the route discards them too.
- **Quick entry's line is not kept.** It is a view of the route, made again
  from the draft each time the page opens; "Use this route" writes the result
  into the draft, and Cancel or Back leaves the draft as it was.
- **Leaving.** As in the waypoints editor: links between the editor's pages
  do not ask, a link out of it asks "Discard route changes?", Back means "not
  now", and a reload keeps the draft. The route page's Cancel is the way to
  throw the draft away on purpose; it asks first when there are changes.
