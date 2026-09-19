/** Mocked Corryong-shaped data. Nothing here talks to an API. */

export type Category = "hg" | "pg";
export type ScoringFormat = "gap" | "open_distance";
export type PilotClass = "Open" | "Floater" | "Sport";

export interface Comp {
  id: string;
  name: string;
  category: Category;
  scoringFormat: ScoringFormat;
  classes: PilotClass[];
  place: string;
  timezone: string;
  firstDate: string;
  lastDate: string;
  test?: boolean;
  waypointCount: number;
  pilotCount: number;
}

export interface Task {
  id: string;
  compId: string;
  name: string;
  date: string;
  classes: PilotClass[];
  distanceKm: number;
  start: string;
  goalDeadline: string;
  status: "scored" | "flying" | "briefed";
}

export interface Turnpoint {
  code: string;
  name: string;
  role: "TAKEOFF" | "SSS" | "TP" | "ESS" | "GOAL";
  radiusM: number;
  altitudeM: number;
  coords: string;
  legKm?: number;
  bearing?: number;
  wind?: "tail" | "cross" | "head";
}

export interface Waypoint {
  id: number;
  code: string;
  name: string;
  coords: string;
  altitudeM?: number;
  mapAltitudeM: number;
  radiusM: number;
}

export interface ScoreRow {
  rank: number;
  pilotId: string;
  name: string;
  nation: string;
  klass: PilotClass;
  t1: number;
  t2: number;
  t3: number;
  total: number;
  team?: string;
}

export interface ReportCard {
  pilotId: string;
  name: string;
  taskName: string;
  rank: number;
  points: number;
  available: number;
  headline: string;
  sections: {
    id: string;
    title: string;
    points?: number;
    available?: number;
    items: { text: string; value?: string; arith?: string }[];
  }[];
}

export interface Flight {
  id: string;
  name: string;
  date: string;
  km: number;
  duration: string;
}

export interface AnalysisBox {
  slug: string;
  label: string;
  fact: string;
}

export const COMPS: Comp[] = [
  {
    id: "corryong",
    name: "Corryong Cup 2026",
    category: "hg",
    scoringFormat: "gap",
    classes: ["Open", "Floater"],
    place: "Corryong, NSW",
    timezone: "Australia/Sydney",
    firstDate: "2026-01-04",
    lastDate: "2026-01-10",
    waypointCount: 48,
    pilotCount: 99,
  },
  {
    id: "bright",
    name: "Bright Open 2026",
    category: "hg",
    scoringFormat: "gap",
    classes: ["Open", "Sport"],
    place: "Bright, VIC",
    timezone: "Australia/Melbourne",
    firstDate: "2026-02-14",
    lastDate: "2026-02-21",
    waypointCount: 36,
    pilotCount: 64,
  },
  {
    id: "manilla",
    name: "Manilla Classic",
    category: "pg",
    scoringFormat: "gap",
    classes: ["Open"],
    place: "Manilla, NSW",
    timezone: "Australia/Sydney",
    firstDate: "2026-03-07",
    lastDate: "2026-03-14",
    waypointCount: 72,
    pilotCount: 118,
  },
  {
    id: "bigchip",
    name: "Big Chip",
    category: "hg",
    scoringFormat: "open_distance",
    classes: ["Open"],
    place: "Lake Keepit, NSW",
    timezone: "Australia/Sydney",
    firstDate: "2026-01-18",
    lastDate: "2026-01-18",
    test: true,
    waypointCount: 12,
    pilotCount: 8,
  },
];

export const TASKS: Task[] = [
  {
    id: "t1",
    compId: "corryong",
    name: "Task 1 — Open",
    date: "2026-01-04",
    classes: ["Open"],
    distanceKm: 82.4,
    start: "14:30",
    goalDeadline: "23:00",
    status: "scored",
  },
  {
    id: "t2",
    compId: "corryong",
    name: "Task 2 — Open",
    date: "2026-01-06",
    classes: ["Open"],
    distanceKm: 96.1,
    start: "14:30",
    goalDeadline: "23:00",
    status: "scored",
  },
  {
    id: "t3",
    compId: "corryong",
    name: "Task 2 — Floater",
    date: "2026-01-06",
    classes: ["Floater"],
    distanceKm: 54.2,
    start: "14:45",
    goalDeadline: "22:30",
    status: "scored",
  },
  {
    id: "t4",
    compId: "corryong",
    name: "Task 3 — Open",
    date: "2026-01-07",
    classes: ["Open"],
    distanceKm: 71.8,
    start: "14:15",
    goalDeadline: "22:30",
    status: "scored",
  },
  {
    id: "t5",
    compId: "corryong",
    name: "Task 3 — Floater",
    date: "2026-01-07",
    classes: ["Floater"],
    distanceKm: 48.6,
    start: "14:30",
    goalDeadline: "22:00",
    status: "scored",
  },
];

export const TURNPOINTS: Turnpoint[] = [
  {
    code: "ELLIOT",
    name: "Elliot",
    role: "TAKEOFF",
    radiusM: 400,
    altitudeM: 920,
    coords: "36°11.150′S 147°58.600′E",
  },
  {
    code: "ELLIOT",
    name: "Elliot",
    role: "SSS",
    radiusM: 3000,
    altitudeM: 920,
    coords: "36°11.150′S 147°58.600′E",
    wind: "cross",
  },
  {
    code: "HALFWY",
    name: "Halfway",
    role: "TP",
    radiusM: 1000,
    altitudeM: 780,
    coords: "36°15.928′S 147°52.407′E",
    legKm: 14.2,
    bearing: 228,
    wind: "head",
  },
  {
    code: "BIGARA",
    name: "Biggara",
    role: "TP",
    radiusM: 7000,
    altitudeM: 540,
    coords: "36°15.818′S 148°01.257′E",
    legKm: 13.6,
    bearing: 92,
    wind: "tail",
  },
  {
    code: "GRGGRG",
    name: "Greg Greg",
    role: "TP",
    radiusM: 2000,
    altitudeM: 610,
    coords: "36°03.544′S 148°02.390′E",
    legKm: 22.8,
    bearing: 4,
    wind: "cross",
  },
  {
    code: "DWYERS",
    name: "Dwyers",
    role: "TP",
    radiusM: 7000,
    altitudeM: 720,
    coords: "36°14.567′S 147°53.021′E",
    legKm: 25.4,
    bearing: 214,
    wind: "head",
  },
  {
    code: "KHANCO",
    name: "Khancoban",
    role: "ESS",
    radiusM: 1000,
    altitudeM: 340,
    coords: "36°12.973′S 148°06.587′E",
    legKm: 20.1,
    bearing: 76,
    wind: "tail",
  },
  {
    code: "KHANCO",
    name: "Khancoban",
    role: "GOAL",
    radiusM: 1000,
    altitudeM: 340,
    coords: "36°12.973′S 148°06.587′E",
  },
];

export const WAYPOINTS: Waypoint[] = [
  {
    id: 1,
    code: "ELLIOT",
    name: "Elliot's Knob",
    coords: "36°11.150′S 147°58.600′E",
    altitudeM: 920,
    mapAltitudeM: 918,
    radiusM: 400,
  },
  {
    id: 2,
    code: "BEACH",
    name: "Khancoban Beach",
    coords: "36°13.410′S 148°07.120′E",
    altitudeM: 0,
    mapAltitudeM: 4,
    radiusM: 400,
  },
  {
    id: 3,
    code: "HALFWY",
    name: "Halfway",
    coords: "36°15.928′S 147°52.407′E",
    altitudeM: 780,
    mapAltitudeM: 776,
    radiusM: 400,
  },
  {
    id: 4,
    code: "BIGARA",
    name: "Biggara",
    coords: "36°15.818′S 148°01.257′E",
    altitudeM: 540,
    mapAltitudeM: 533,
    radiusM: 400,
  },
  {
    id: 5,
    code: "GRGGRG",
    name: "Greg Greg",
    coords: "36°03.544′S 148°02.390′E",
    altitudeM: 610,
    mapAltitudeM: 942,
    radiusM: 400,
  },
  {
    id: 6,
    code: "DWYERS",
    name: "Dwyers Creek",
    coords: "36°14.567′S 147°53.021′E",
    altitudeM: 720,
    mapAltitudeM: 714,
    radiusM: 400,
  },
  {
    id: 7,
    code: "KHANCO",
    name: "Khancoban",
    coords: "36°12.973′S 148°06.587′E",
    altitudeM: 340,
    mapAltitudeM: 338,
    radiusM: 400,
  },
  {
    id: 8,
    code: "TOWONG",
    name: "Towong",
    coords: "36°07.210′S 148°00.440′E",
    mapAltitudeM: 412,
    radiusM: 400,
  },
];

export const SCORES: ScoreRow[] = [
  { rank: 1, pilotId: "durand", name: "Jon Durand", nation: "AUS", klass: "Open", t1: 874, t2: 912, t3: 647, total: 2433, team: "Moyes" },
  { rank: 2, pilotId: "holtkamp", name: "Rohan Holtkamp", nation: "AUS", klass: "Open", t1: 841, t2: 888, t3: 621, total: 2350, team: "Airborne" },
  { rank: 3, pilotId: "gunn", name: "Grant Gunn", nation: "AUS", klass: "Open", t1: 802, t2: 870, t3: 598, total: 2270, team: "Moyes" },
  { rank: 4, pilotId: "brown", name: "Steve Brown", nation: "AUS", klass: "Open", t1: 790, t2: 844, t3: 580, total: 2214, team: "Airborne" },
  { rank: 5, pilotId: "rowntree", name: "Adam Rowntree", nation: "AUS", klass: "Open", t1: 766, t2: 821, t3: 572, total: 2159, team: "Moyes" },
  { rank: 6, pilotId: "sutton", name: "Cameron Sutton", nation: "AUS", klass: "Open", t1: 740, t2: 798, t3: 551, total: 2089 },
  { rank: 7, pilotId: "taylor", name: "Rick Taylor", nation: "NZL", klass: "Open", t1: 721, t2: 770, t3: 540, total: 2031 },
  { rank: 8, pilotId: "hare", name: "Phil Hare", nation: "AUS", klass: "Open", t1: 698, t2: 744, t3: 512, total: 1954 },
  { rank: 9, pilotId: "opsanger", name: "Jochen Opsanger", nation: "GER", klass: "Open", t1: 670, t2: 731, t3: 498, total: 1899 },
  { rank: 10, pilotId: "free", name: "Tove Heaney", nation: "AUS", klass: "Open", t1: 655, t2: 702, t3: 481, total: 1838 },
  { rank: 1, pilotId: "lannstrom", name: "Jonas Lannstrom", nation: "SWE", klass: "Floater", t1: 612, t2: 640, t3: 401, total: 1653, team: "Wills Wing" },
  { rank: 2, pilotId: "gardner", name: "Dave Gardner", nation: "AUS", klass: "Floater", t1: 588, t2: 611, t3: 390, total: 1589 },
  { rank: 3, pilotId: "bayly", name: "Tony Bayly", nation: "AUS", klass: "Floater", t1: 560, t2: 598, t3: 372, total: 1530 },
  { rank: 4, pilotId: "emms", name: "Ken Emms", nation: "AUS", klass: "Floater", t1: 541, t2: 570, t3: 350, total: 1461 },
  { rank: 5, pilotId: "forrester", name: "Craig Forrester", nation: "AUS", klass: "Floater", t1: 520, t2: 544, t3: 338, total: 1402 },
];

export const REPORT: ReportCard = {
  pilotId: "durand",
  name: "Jon Durand",
  taskName: "Task 2 — Open",
  rank: 1,
  points: 912,
  available: 1000,
  headline: "Goal at 16:41 — 912 of 1,000 points",
  sections: [
    {
      id: "flight",
      title: "The flight",
      items: [
        { text: "Started on the 14:30 gate", value: "14:30:12" },
        { text: "Reached ESS", value: "16:38:04" },
        { text: "Made goal", value: "16:41:22" },
        { text: "Speed section", value: "96.1 km in 2h 07m" },
      ],
    },
    {
      id: "day",
      title: "Day quality",
      points: 1000,
      items: [
        { text: "Launch validity", value: "1.00", arith: "nL / N = 62 / 62" },
        { text: "Distance validity", value: "1.00", arith: "best / nomDist = 96.1 / 70" },
        { text: "Time validity", value: "1.00", arith: "bestTime / nomTime = 2.13 / 2.5" },
        { text: "Day quality", value: "1.00", arith: "LV × DV × TV = 1.00" },
      ],
    },
    {
      id: "distance",
      title: "Distance points",
      points: 420,
      available: 450,
      items: [
        { text: "Flown distance", value: "96.1 km" },
        {
          text: "Distance points",
          value: "420.0",
          arith: "450 × (96.1 / 96.1) = 420",
        },
      ],
    },
    {
      id: "time",
      title: "Time points",
      points: 312,
      available: 350,
      items: [
        { text: "Speed-section time", value: "2:07:52" },
        { text: "Fastest in class", value: "2:07:52 (this pilot)" },
        { text: "Time points", value: "312.0", arith: "350 × (Tmin / T)³ = 312" },
      ],
    },
    {
      id: "leading",
      title: "Leading points",
      points: 140,
      available: 140,
      items: [
        { text: "Leading coefficient", value: "1.84" },
        { text: "Best LC in class", value: "1.84" },
        { text: "Leading points", value: "140.0", arith: "140 × (LCmin / LC) = 140" },
      ],
    },
    {
      id: "arrival",
      title: "Arrival points",
      points: 40,
      available: 60,
      items: [
        { text: "Goal position", value: "1st" },
        { text: "Arrival points", value: "40.0", arith: "60 × (0.2 + 0.8 × √((N−p+1)/N))" },
      ],
    },
    {
      id: "cleaning",
      title: "Track data cleaning",
      items: [
        { text: "GPS spikes removed", value: "3" },
        { text: "Barometer used for altitude", value: "yes" },
        { text: "Max GPS vs baro disagreement", value: "38 m" },
      ],
    },
  ],
};

export const FLIGHTS: Flight[] = [
  { id: "f1", name: "Corryong T2", date: "2026-01-06", km: 96.1, duration: "3h 12m" },
  { id: "f2", name: "Corryong T1", date: "2026-01-04", km: 82.4, duration: "2h 58m" },
  { id: "f3", name: "Kosciuszko loop", date: "2025-12-28", km: 54.0, duration: "2h 10m" },
];

export const ANALYSIS: AnalysisBox[] = [
  { slug: "strategies", label: "Winning strategies", fact: "Early start and tight cores separated the field (ρ = 0.71)." },
  { slug: "weather", label: "Weather", fact: "NW 18–22 km/h, cloudbase 2,400 m, cu building after 13:00." },
  { slug: "thermals", label: "Thermals", fact: "14 shared thermals; the 15:10 climb over Biggara leaned 1.4 m/s." },
  { slug: "metrics", label: "Metric details", fact: "25 behaviours, 62 scored tracks." },
  { slug: "style", label: "Flying style", fact: "Three clusters: ridge-runners, gaggle sitters, and the lead gaggle." },
  { slug: "method", label: "How this was measured", fact: "Spearman ρ against GAP rank; 4 tracks withheld." },
];

export const ACTIVITY = [
  { when: "2h ago", text: "Rohan Holtkamp submitted a track for Task 3 — Open" },
  { when: "3h ago", text: "Scores recomputed for Task 3 — Open" },
  { when: "yesterday", text: "Task 3 — Open published · 71.8 km" },
  { when: "2 days ago", text: "Grant Gunn replaced a track for Task 2 — Open" },
];

export const PILOTS = SCORES.map((s, i) => ({
  id: s.pilotId,
  name: s.name,
  nation: s.nation,
  klass: s.klass,
  civl: 18000 + i * 37,
  status: i === 8 ? "DNF" : i === 9 ? "absent" : "present",
}));

export function categoryLabel(cat: Category): string {
  return cat === "hg" ? "Hang gliding" : "Paragliding";
}

export function scoringLabel(fmt: ScoringFormat): string {
  return fmt === "gap" ? "GAP" : "Open distance";
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1));
  return dt.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function formatDateRange(a: string, b: string): string {
  if (a === b) return formatDate(a);
  return `${formatDate(a)} – ${formatDate(b)}`;
}

export function formatRadius(m: number): string {
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

export function getComp(id: string | undefined): Comp | undefined {
  if (!id) return undefined;
  return COMPS.find((c) => c.id === id);
}

export function tasksFor(compId: string | undefined): Task[] {
  if (!compId) return [];
  return TASKS.filter((t) => t.compId === compId);
}

export function getTask(id: string | undefined): Task | undefined {
  if (!id) return undefined;
  return TASKS.find((t) => t.id === id);
}

export function scoresFor(klass: PilotClass): ScoreRow[] {
  return SCORES.filter((s) => s.klass === klass);
}
