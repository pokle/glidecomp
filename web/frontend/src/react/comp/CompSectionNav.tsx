/**
 * The competition section bar — the six (or fewer) links that look like tabs
 * on the hub and on every sibling page they go to.
 *
 * Until this lived only on the hub (`pages/CompDetail.tsx`), so landing on
 * Scores / Waypoints / Pilots / Comp analysis dropped the reader out of the
 * set they had just clicked. One component, one landmark (`nav` "Sections"),
 * the same labels in the same order.
 *
 * Tasks and Activity are in-page jumps while the reader is already on the
 * hub (`#tasks` / `#activity`); from anywhere else they are links back to
 * those anchors. The other four are always routed pages. Pilots is
 * admin-only (the roster is a management surface; visitors find every
 * pilot in the scores). Comp analysis is hidden on an open-distance
 * competition, which has no legs to measure.
 */
import { Link, useLocation } from "react-router-dom";
import { PriorityNav, type PriorityNavItem } from "@/react/rac/priority-nav";
import { cn } from "@/react/lib/utils";
import { useMounted } from "../lib/use-mounted";
import { COMP_ANALYSIS_LABEL } from "../lib/crumbs";
import {
  compPath,
  compScoresPath,
  compWaypointsPath,
  compPilotsPath,
  compAnalysisPath,
} from "../lib/slug";
import type { CompDetailData } from "./types";

export type CompSection =
  | "tasks"
  | "scores"
  | "waypoints"
  | "pilots"
  | "analysis"
  | "activity";

export type CompSectionNavItemModel = {
  id: CompSection;
  label: string;
  /** Destination for the overflow menu. Absent when the row is an in-page jump. */
  href?: string;
  /** True when this entry scrolls the hub rather than routing. */
  inPage: boolean;
  isCurrent: boolean;
};

function counted(noun: string, n: number | undefined): string {
  return n === undefined ? noun : `${noun} (${n})`;
}

/**
 * Which of the section-bar entries the URL is on.
 *
 * The hash is only consulted on the hub (`/comp/:id`): `#activity` marks
 * Activity, and anything else (including a missing hash) marks Tasks. The
 * fragment is never sent to the server, so the caller must pass `""` until
 * the component has mounted — otherwise SSR markup and the first client
 * render would disagree on a `/comp/:id#activity` load.
 */
export function currentCompSection(pathname: string, hash: string): CompSection {
  const parts = pathname.split("/").filter(Boolean);
  const after = parts[0] === "comp" ? parts[2] : undefined;
  if (after === "scores") return "scores";
  if (after === "waypoints") return "waypoints";
  if (after === "pilots") return "pilots";
  if (after === "analysis") return "analysis";
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (fragment === "activity") return "activity";
  return "tasks";
}

export function buildCompSectionNavModel(opts: {
  compId: string;
  compName: string;
  taskCount?: number;
  waypointCount?: number;
  pilotCount?: number;
  scoringFormat?: string | null;
  isAdmin: boolean;
  pathname: string;
  hash: string;
}): CompSectionNavItemModel[] {
  const hub = compPath(opts.compId, opts.compName);
  const after = opts.pathname.split("/").filter(Boolean)[2];
  const onHub = after === undefined;
  const current = currentCompSection(opts.pathname, opts.hash);

  const items: CompSectionNavItemModel[] = [
    {
      id: "tasks",
      label: counted("Tasks", opts.taskCount),
      href: onHub ? undefined : `${hub}#tasks`,
      inPage: onHub,
      isCurrent: current === "tasks",
    },
    {
      id: "scores",
      label: "Scores",
      href: compScoresPath(opts.compId, opts.compName),
      inPage: false,
      isCurrent: current === "scores",
    },
    {
      id: "waypoints",
      label: counted("Waypoints", opts.waypointCount),
      href: compWaypointsPath(opts.compId, opts.compName),
      inPage: false,
      isCurrent: current === "waypoints",
    },
  ];

  if (opts.isAdmin) {
    items.push({
      id: "pilots",
      label: counted("Pilots", opts.pilotCount),
      href: compPilotsPath(opts.compId, opts.compName),
      inPage: false,
      isCurrent: current === "pilots",
    });
  }

  if (opts.scoringFormat !== "open_distance") {
    items.push({
      id: "analysis",
      label: COMP_ANALYSIS_LABEL,
      href: compAnalysisPath(opts.compId, opts.compName),
      inPage: false,
      isCurrent: current === "analysis",
    });
  }

  items.push({
    id: "activity",
    label: "Activity",
    href: onHub ? undefined : `${hub}#activity`,
    inPage: onHub,
    isCurrent: current === "activity",
  });

  return items;
}

export type CompSectionNavProps = {
  compId: string;
  compName: string;
  taskCount?: number;
  waypointCount?: number;
  pilotCount?: number;
  scoringFormat?: string | null;
  isAdmin: boolean;
};

/** Props the hub and every sibling page already have from the comp payload. */
export function compSectionNavProps(
  compId: string,
  comp: Pick<
    CompDetailData,
    "name" | "tasks" | "waypoint_count" | "pilot_count" | "scoring_format"
  >,
  isAdmin: boolean
): CompSectionNavProps {
  return {
    compId,
    compName: comp.name,
    taskCount: comp.tasks.length,
    waypointCount: comp.waypoint_count,
    pilotCount: comp.pilot_count,
    scoringFormat: comp.scoring_format,
    isAdmin,
  };
}

const sectionLinkClass = (isCurrent: boolean) =>
  cn(
    "hover:text-foreground hover:underline underline-offset-4",
    isCurrent && "text-foreground underline"
  );

/**
 * The section bar's in-page entries, for when they have folded into the
 * overflow menu. In the row they are plain `#id` anchors and the browser does
 * this itself; from a menu item the jump has to be made by hand — and NOT as a
 * routed href, because react-router would push a history entry and
 * lib/scroll-restoration.ts would start it at the top, which is the one thing
 * an in-page anchor must not do. `scroll-mt-24` on the section keeps the
 * landing clear of the sticky bars.
 */
const scrollToSection = (id: string) => () => {
  document.getElementById(id)?.scrollIntoView();
};

export function CompSectionNav({
  compId,
  compName,
  taskCount,
  waypointCount,
  pilotCount,
  scoringFormat,
  isAdmin,
}: CompSectionNavProps) {
  const { pathname, hash } = useLocation();
  const mounted = useMounted();
  const models = buildCompSectionNavModel({
    compId,
    compName,
    taskCount,
    waypointCount,
    pilotCount,
    scoringFormat,
    isAdmin,
    pathname,
    hash: mounted ? hash : "",
  });

  const items: PriorityNavItem[] = models.map((item) => ({
    id: item.id,
    label: item.label,
    href: item.href,
    onAction: item.inPage ? scrollToSection(item.id) : undefined,
    isCurrent: item.isCurrent,
    children: item.inPage ? (
      <a
        href={`#${item.id}`}
        className={sectionLinkClass(item.isCurrent)}
        aria-current={item.isCurrent ? true : undefined}
      >
        {item.label}
      </a>
    ) : (
      <Link
        to={item.href!}
        className={sectionLinkClass(item.isCurrent)}
        aria-current={item.isCurrent ? "page" : undefined}
      >
        {item.label}
      </Link>
    ),
  }));

  return (
    <nav
      aria-label="Sections"
      className="sticky top-0 z-30 -mx-4 mt-3 border-b bg-background/90 px-4 py-2 text-sm text-muted-foreground backdrop-blur-sm sm:top-[61px] [@media(max-height:500px)]:static print:hidden"
    >
      {/* Six links wrapped onto three lines on a phone, which is most of a
          sticky bar and none of the page. They stay on one line now and fold
          into "More" from the right (issue #639). */}
      <PriorityNav
        items={items}
        className="gap-x-4"
        menuLabel="More sections"
      />
    </nav>
  );
}
