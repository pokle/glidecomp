# The app's accessibility and performance audit

Stage 9 of [the mobile app plan](../docs/2026-10-05-mobile-app-plan.md) owes an
accessibility audit and performance numbers. Part of each can be checked in
code, and is; the rest needs a phone in a hand, and is this checklist. The
standard is the website's: [docs/accessibility-standard.md](../docs/accessibility-standard.md)
(WCAG 2.2 AA).

## Checked in code

- **Every button says it is one.** `__tests__/accessibility-lint.test.ts`
  fails on a `Pressable` without `accessibilityRole`.
- **Every chart is labelled, or hidden with its legend.** The same test fails
  on an unlabelled `Svg`. Each chart's label says what it shows and that the
  table under it has the figures, which is where the exact reading lives.
- **Targets are 44 pt.** Form buttons, choices and switches are at least 44 pt
  tall (`src/ui/form.tsx`); header text buttons carry a 12 pt `hitSlop`;
  native list rows are the platform's own.
- **Text scales.** Nothing sets `allowFontScaling={false}` or a fixed height
  on a text container; chart labels are drawn in the screen's own points.
- **Colour is never the only signal.** The day profile's lane names its marks
  in a legend; the cleaning chart's legend repeats each line's dash.
- **A permission prompt is asked for at the moment it is needed**:
  notifications ask when a competition's are first turned on, never at launch.

## On a phone (the owner's checks)

Run each with VoiceOver (iOS) and TalkBack (Android):

- [ ] Submit a track from the Submit tab, start to receipt.
- [ ] Open a comp, a task, the scores and a report card; every row reads its
      title and its value, in order.
- [ ] The waypoints list: a row reads as one item and its pin as the action.
- [ ] The route editor: each turnpoint, then its up and down buttons.
- [ ] The QR screen: the code is announced with its task and count.
- [ ] Every alert (delete, discard, replace roster) is reached and answered.

Then, without a screen reader:

- [ ] The largest text size (iOS Larger Accessibility Sizes; Android font
      size and display size at maximum): no text is cut off, nothing overlaps,
      every screen still scrolls to its last row.
- [ ] Light and dark: every chart's ink and the error red stay readable.
- [ ] Reduce Motion: the track map's throbbing marker is the only animation;
      check it is not distracting.

## Performance (measured on a mid-range Android phone)

Use a release build (`bun run android -- --variant release`) — a debug build
loads its JavaScript from Metro and measures that instead.

| What | How | Target |
|---|---|---|
| Cold start | `adb shell am start -W com.glidecomp.app.dev/.MainActivity`, `TotalTime` | under 2 s |
| A large comp's lists | The roster and waypoints of the biggest bundled comp (`bun run seed` locally): scroll top to bottom with the GPU profiler on | no dropped frames |
| The report card | Time from the row tap to the first explanation row, with a cold tracklog | under 1 s for the card; the map may follow |
| The task analysis | A cold analysis: the pending screen appears at once, and the sections fill when it lands | no spinner longer than the poll |

Write each measurement here, with the phone and the date, so the next one
has something to compare with.

## Not done yet

- **iPad's split view** (stage 0 decision 5: the comp owns the sidebar,
  tasks push in the detail column). The app runs the phone layout on iPad
  (`supportsTablet: false`); the split view needs an iPad to build against,
  and is a stage of its own.
