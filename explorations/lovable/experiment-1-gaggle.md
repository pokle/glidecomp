# Lovable experiment 1 - Gaggle 

I'm trying to see if Lovable.dev can build something like TaskScore.

## Prompt

An app that helps hang glider and paraglider pilots analyse their gps track logs. 

It allows them to upload an IGC file with their GPS track, and it draws the track on a terrain map. I've attached an IGC parser written in TypeScript to help you parse IGC files.

It should also allow pilots to upload track logs of their team members or others flying with them - called the gaggle. The gaggle's track isn't drawn on the map because it would be too much noise. When the user clicks on parts of their own track, a 1 minute long translucent trail of every pilot in the gaggle is shown corresponding to the minute before the point on the track that was selected.

Attached: igc-parser.ts

## Result

It built something that works first time!

- https://gaggle.lovable.app/
- https://github.com/pokle/gaggle-glider
- file://../gaggle-glider/

It placed `igc-parser.ts` verbatim in `src/lib/igc-parser.ts`


## Comments

- I need a way to hit "Play", and watch the gliders fly in real time.
- The current pilot label needs the current pilot's name!
- The trail should be longer.
- I need some way to rank gaggle pilots who were flying with the current pilot.
- I need a way to focus on a different pilot.
