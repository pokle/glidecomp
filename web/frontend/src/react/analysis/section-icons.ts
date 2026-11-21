/**
 * The line icon for each page of a task analysis, on its box on the contents
 * page.
 *
 * Kept out of sections.ts on purpose: that list is imported by the SSR Pages
 * Function to build its route pattern, which has no use for an icon set.
 *
 * One icon means one thing across the app (docs/interaction-guide.md 5.5), so
 * none of these is used anywhere else. `ChartColumnIcon` is
 * not among them: it stands for an analysis as a whole, and every one of these
 * is a part of one.
 */
import {
  RulerIcon,
  ShapesIcon,
  Table2Icon,
  TornadoIcon,
  TrophyIcon,
  UsersRoundIcon,
  WindIcon,
  type LucideIcon,
} from "lucide-react";
import type { TaskAnalysisSectionSlug } from "./sections";

export const TASK_ANALYSIS_ICONS: Record<TaskAnalysisSectionSlug | "similar", LucideIcon> = {
  strategies: TrophyIcon,
  weather: WindIcon,
  thermals: TornadoIcon,
  metrics: Table2Icon,
  style: ShapesIcon,
  similar: UsersRoundIcon,
  method: RulerIcon,
};
