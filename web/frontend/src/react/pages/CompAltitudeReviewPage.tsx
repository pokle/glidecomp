/**
 * The altitude review — /comp/:compId/waypoints/altitudes, and one waypoint
 * of it at /altitudes/:n. ADMIN-ONLY and NOT SSR'd (noindex shells in
 * functions/comp/[[path]].ts). What they show is comp/AltitudeReview.tsx.
 *
 * Opened by "Check altitudes" on the waypoints page, which reads the terrain
 * and puts what it found into the waypoints draft (comp/waypoints-draft.ts)
 * before coming here. So this page is handed nothing: the review — the
 * readings, and the list's membership and order — is in the draft, and
 * survives going into a waypoint and back, and a reload.
 *
 * Leaving is the bar's Back, and nothing else (issue #863 — each page had a
 * Done that did the same thing, and one waypoint had "All N" as well):
 *   - from one waypoint, it returns to the review's LIST, never out of the
 *     review;
 *   - from the list, it returns to the waypoints and leaves the review open,
 *     for Forward to find. The next Check altitudes replaces it.
 * Each is a real Back when the page was opened from the one it returns to,
 * so that page comes back as it was left; otherwise this page is replaced
 * with it.
 *
 * Reached with no review in the draft — a link opened in another tab, or
 * Forward after the review was closed — the list offers the check itself, and
 * one waypoint of it goes to the list.
 */
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Button } from "@/react/rac/button";
import { Page, PageBar } from "@/react/rac/page-bar";
import { underAltitudeReview, underCompWaypoints } from "../lib/crumbs";
import { compAltitudeReviewPath } from "../lib/slug";
import { toast } from "../lib/toast";
import { useCanonicalPath } from "../lib/use-canonical-path";
import {
  AltitudeReviewDetail,
  AltitudeReviewList,
  useHeldReading,
} from "../comp/AltitudeReview";
import {
  useAltitudeCheck,
  useWaypointsEditor,
  type WaypointsEditor,
} from "../comp/use-waypoints-editor";
import { waypointsEditorGate } from "../comp/WaypointsEditorGate";
import {
  acceptMapAltitudes,
  convertFromFeet,
  reviewEntry,
  updateRow,
  type AltitudeReviewEntry,
} from "../comp/waypoints-draft";

/** "Took the map altitude for …", for an accept of any size. */
function tookToast(n: number) {
  toast.success(
    `Took the map altitude for ${n} waypoint${n === 1 ? "" : "s"}` +
      " · nothing is saved until you press Save"
  );
}

export function CompAltitudeReviewPage() {
  const editor = useWaypointsEditor();
  const { rowId: rowParam } = useParams<{ rowId?: string }>();
  const id = rowParam === undefined ? null : Number(rowParam);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const check = useAltitudeCheck(editor);
  const { urlId, compName, draft } = editor;

  useCanonicalPath(
    compName ? compAltitudeReviewPath(urlId, compName, id ?? undefined) : null
  );

  const trail = underCompWaypoints(urlId, compName);
  const gate = waypointsEditorGate(editor, {
    title: id === null ? "Check altitudes" : "Waypoint",
    trail: id === null ? trail : underAltitudeReview(urlId, compName),
  });
  if (gate) return gate;

  const reviewPath = compAltitudeReviewPath(urlId, compName);
  const review = draft.review;

  if (!review) {
    // One waypoint of a review that is not there: the list says what to do.
    if (id !== null) return <Navigate replace to={reviewPath} />;
    return (
      <Page bar={<PageBar title="Check altitudes" trail={trail} />}>
        {/* On the page, not in the bar: with no review open it is all the
            page has, and where the review will appear. */}
        <Button
          className="h-11 px-5"
          isDisabled={draft.rows.length === 0}
          isPending={check.checking}
          pendingLabel="Checking altitudes"
          onPress={() => void check.run()}
        >
          Check altitudes
        </Button>
      </Page>
    );
  }

  // Every waypoint, in file order, as the review sees it now.
  const entries = draft.rows.map((r) => reviewEntry(draft, r));

  if (id !== null) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) return <NotFound title="Waypoint not found" />;
    return (
      <ReviewWaypoint
        // A fresh page per waypoint: the reading it holds is its own.
        key={id}
        editor={editor}
        entry={entry}
        onBack={() => editor.leave(reviewPath)}
      />
    );
  }

  const showAll = searchParams.get("all") === "1";
  const byId = new Map(entries.map((e) => [e.id, e]));
  const listed = new Set(review.listed);
  const ids =
    showAll || listed.size === 0 ? review.order : review.order.filter((i) => listed.has(i));
  // A row whose waypoint has gone is dropped rather than rendered empty.
  const shown = ids
    .map((i) => byId.get(i))
    .filter((e): e is AltitudeReviewEntry => e !== undefined);

  return (
    <AltitudeReviewList
      compId={urlId}
      compName={compName}
      entries={entries}
      shown={shown}
      listedCount={listed.size}
      showAll={showAll}
      // In the URL, so Back from a waypoint finds the list as wide as it was.
      onShowAll={(all) =>
        setSearchParams(all ? { all: "1" } : {}, { replace: true, state: location.state })
      }
      onOpen={(rowId) =>
        navigate(compAltitudeReviewPath(urlId, compName, rowId))
      }
      onAccept={(rowIds) => {
        let accepted = 0;
        editor.update((d) => {
          const r = acceptMapAltitudes(d, rowIds);
          accepted = r.accepted;
          return r.draft;
        });
        if (accepted > 0) tookToast(accepted);
      }}
      onConvertFromFeet={() => {
        let converted = 0;
        editor.update((d) => {
          const r = convertFromFeet(d);
          converted = r.converted;
          return r.draft;
        });
        if (converted > 0) {
          toast.success(
            `Converted ${converted} altitude${converted === 1 ? "" : "s"} from feet to metres` +
              " · nothing is saved until you press Save"
          );
        }
      }}
    />
  );
}

function ReviewWaypoint({
  editor,
  entry,
  onBack,
}: {
  editor: WaypointsEditor;
  entry: AltitudeReviewEntry;
  /** Back to the review's list, once the map's altitude has been taken. */
  onBack: () => void;
}) {
  // The reading as this page opened: see AltitudeReviewDetail.
  const mapAlt = useHeldReading(entry.mapAlt);
  const set = (patch: Parameters<typeof updateRow>[2]) =>
    editor.update((d) => updateRow(d, entry.id, patch));
  return (
    <AltitudeReviewDetail
      compId={editor.urlId}
      compName={editor.compName}
      entry={entry}
      mapAlt={mapAlt}
      onUseMapAltitude={(altitude) => {
        set({ altitude: String(Math.round(altitude)) });
        tookToast(1);
        onBack();
      }}
      onEditAltitude={(altitude) =>
        set({ altitude: altitude === undefined ? "" : String(Math.round(altitude)) })
      }
      onEditCoords={(coords) => set({ coords })}
    />
  );
}
