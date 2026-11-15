/**
 * Sample data for the page-bar prototype (/proto). Fixed, in memory, and
 * nothing to do with the API: the prototype has to open on a branch preview
 * with no account and no seeded database.
 */

export const P = "/proto";

export const COMP = {
  name: "Corryong Cup 2026",
  path: `${P}/comp/corryong`,
  meta: "HG · GAP · open, floater · 5 Jan – 7 Jan 2026",
};

export const COMPS = [
  { id: "corryong", name: "Corryong Cup 2026", meta: "HG · GAP · open, floater", dates: "5 Jan – 7 Jan 2026" },
  {
    id: "brasov",
    name: "SkyDreamers Paragliding Nationals Brasov 2026",
    meta: "PG · GAP · en-b, en-c, en-d",
    dates: "7 Jun 2026",
  },
  { id: "bigchip", name: "Big Chip (Sample)", meta: "HG · Open distance · open", dates: "14 Feb – 15 Feb 2026" },
  { id: "unungra", name: "Unungra Cup", meta: "PG · GAP · open", dates: "8 Dec – 12 Dec 2020" },
];

export const TASKS = [
  { id: "1", name: "Task 1 (Open)", day: "Mon, 5 Jan 2026" },
  { id: "2", name: "Task 2 (Open)", day: "Tue, 6 Jan 2026" },
  { id: "3", name: "Task 3 (Open)", day: "Wed, 7 Jan 2026" },
];

export const TASK = { ...TASKS[2], path: `${COMP.path}/task/3` };

export interface Pilot {
  id: string;
  name: string;
  pilotClass: "open" | "floater";
  email: string;
  glider: string;
  team: string;
}

export const PILOTS: Pilot[] = [
  { id: "airie", name: "Airie Merlin", pilotClass: "open", email: "", glider: "", team: "" },
  { id: "amber", name: "Amber Tsai", pilotClass: "floater", email: "", glider: "Moyes Malibu 2", team: "" },
  { id: "andrew", name: "Andrew Berenyi", pilotClass: "floater", email: "", glider: "", team: "" },
  { id: "brett", name: "Brett Davis", pilotClass: "open", email: "brett@example.com", glider: "Moyes RX 3.5", team: "Alpha Gliders" },
  { id: "craig", name: "Craig Taylor", pilotClass: "open", email: "", glider: "Airborne Rev 13.5", team: "Alpha Gliders" },
  { id: "dean", name: "Dean Bayly", pilotClass: "floater", email: "", glider: "", team: "" },
  { id: "donny", name: "Donny Gardner", pilotClass: "floater", email: "", glider: "", team: "" },
  { id: "dustan", name: "Dustan Hansen", pilotClass: "floater", email: "", glider: "Wills Wing Falcon 4", team: "" },
  { id: "glen", name: "Glen Mcfarlane", pilotClass: "open", email: "", glider: "", team: "" },
  { id: "gordon", name: "Gordon Rigg", pilotClass: "open", email: "", glider: "Moyes RX Pro", team: "" },
  { id: "jon", name: "Jon Durand", pilotClass: "open", email: "", glider: "Moyes RX Pro 3.5", team: "" },
  { id: "neale", name: "Neale Halsall", pilotClass: "open", email: "", glider: "", team: "" },
  { id: "olav", name: "Olav Opsanger", pilotClass: "open", email: "", glider: "", team: "" },
  { id: "rohan", name: "Rohan Holtkamp", pilotClass: "open", email: "", glider: "Airborne Rev", team: "" },
  { id: "rory", name: "Rory Duncan", pilotClass: "open", email: "", glider: "Moyes RX 3.5", team: "" },
  { id: "steven", name: "Steven Crosby", pilotClass: "open", email: "", glider: "", team: "" },
];

/** Task 3's results, best first. */
export const RESULTS = [
  { id: "rory", name: "Rory Duncan", points: "1,000.0", detail: "Goal in 1:52:17" },
  { id: "jon", name: "Jon Durand", points: "968.4", detail: "Goal in 1:55:02" },
  { id: "neale", name: "Neale Halsall", points: "902.1", detail: "Goal in 2:01:44" },
  { id: "glen", name: "Glen Mcfarlane", points: "760.3", detail: "62.4 km" },
  { id: "steven", name: "Steven Crosby", points: "601.5", detail: "49.0 km" },
  { id: "gordon", name: "Gordon Rigg", points: "534.9", detail: "43.6 km" },
  { id: "olav", name: "Olav Opsanger", points: "498.0", detail: "40.2 km" },
  { id: "rohan", name: "Rohan Holtkamp", points: "455.7", detail: "36.9 km" },
];

/** The competition's total scores, open class. */
export const SCORES = {
  open: [
    { id: "jon", name: "Jon Durand", total: "2,654.8" },
    { id: "rory", name: "Rory Duncan", total: "2,375.2" },
    { id: "rohan", name: "Rohan Holtkamp", total: "2,345.2" },
    { id: "olav", name: "Olav Opsanger", total: "2,214.7" },
    { id: "glen", name: "Glen Mcfarlane", total: "2,101.3" },
    { id: "steven", name: "Steven Crosby", total: "1,988.6" },
    { id: "gordon", name: "Gordon Rigg", total: "1,902.4" },
    { id: "neale", name: "Neale Halsall", total: "1,870.9" },
  ],
  floater: [
    { id: "dustan", name: "Dustan Hansen", total: "583.4" },
    { id: "donny", name: "Donny Gardner", total: "515.6" },
    { id: "dean", name: "Dean Bayly", total: "382.1" },
    { id: "amber", name: "Amber Tsai", total: "310.0" },
  ],
};

export interface Turnpoint {
  id: string;
  role: string;
  code: string;
  radius: number;
  leg: string;
}

export const ROUTE: Turnpoint[] = [
  { id: "1", role: "Take-off", code: "ELLIOT", radius: 400, leg: "—" },
  { id: "2", role: "Start", code: "ELLIOT", radius: 3000, leg: "3.0 km" },
  { id: "3", role: "", code: "KANGCK", radius: 1500, leg: "4.9 km" },
  { id: "4", role: "", code: "BIGARA", radius: 5000, leg: "2.9 km" },
  { id: "5", role: "", code: "TOOMA", radius: 2000, leg: "28.9 km" },
  { id: "6", role: "", code: "LIGHTH", radius: 400, leg: "11.1 km" },
  { id: "7", role: "", code: "DWYERS", radius: 7000, leg: "16.2 km" },
  { id: "8", role: "End of speed section", code: "KHANCO", radius: 1000, leg: "13.2 km" },
  { id: "9", role: "Goal", code: "KHANCO", radius: 1000, leg: "0.0 km" },
];

/** Comps a roster can be copied from: the long-named action's page. */
export const OTHER_COMPS = [
  { id: "c2025", name: "Corryong Cup 2025", detail: "58 pilots · Jan 2025" },
  { id: "forbes", name: "Forbes Flatlands 2026", detail: "71 pilots · Dec 2025" },
  { id: "dalby", name: "Dalby Big Air 2025", detail: "44 pilots · Apr 2025" },
  { id: "bogong", name: "Bogong Cup 2025", detail: "39 pilots · Feb 2025" },
];

/** The pages under the competition, as the centre menu lists them. */
export const COMP_PAGES = [
  { label: "Scores", to: `${COMP.path}/scores` },
  { label: "Pilots", to: `${COMP.path}/pilots` },
  { label: "Settings", to: `${COMP.path}/settings` },
];

/** A reply after a moment, the way a request has one. */
export function later<T>(value: T, ms = 700): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** The server saying yes, after a moment, in the shape the kit form reads. */
export function accepted(ms = 700) {
  return later(
    { ok: true, status: 200, text: async () => "", json: async (): Promise<unknown> => ({}) },
    ms
  );
}
