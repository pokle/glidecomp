# TaskScore

Helps you analyse hanggliding / paragliding competition tasks.

For pilots and scorers, it provides:

- Detailed analysis of flight performance  
  - Explains scores  
  - Task segments encountered  
  - Re-flies  
- Thermals encountered during the task:  
- Where pilots found their first thermal (left or right of the launch hill?)  
- Was the valley working for the task?  
- Aggregate statistics for the entire task, such as information about how many bombed out, reached goal, landed out etc.

Tasks can be loaded from XContest, or other sources such as a QR code.

Maps can be annotated with information that is used during analysis. For example, if you mark segments near the launch hill (e.g. left spine, front bowl), then analysis will be able to tell if the first thermal was found in one of those segments (e.g. most pilots found their first thermal in the front bowl).

Example of flight analysis:

- 12:30pm launched in tp ELLIOT  
- 12:35pm found first thermal in the front bowl  
- 1:05pm exited start tp ELLIOT at 7000ft from behind the hill.  
- 1:10pm re-entered start tp ELLIOT  
- 1:15pm exited start tp ELLIOT  
- 1:20pm low save  
- 1:30pm tagged tp TOWONG  
- 1:40pm landed in bombout paddock, 7km from NCORGL (30 bombout points)

In the last example, it's useful to know the distance to the next waypoint in the task set.

## Development

**Prerequisites:** [Bun](https://bun.sh/) (also requires Node.js 20+)

```bash
bun install          # Install dependencies
bun run dev          # Local development server
bun run typecheck    # Type checking
bun run test         # Run tests
```

**Deployment:**
- Push to `master` → deploys to production
- Push to other branches → deploys to preview URL

**URLs:**
- Production: https://taskscore.shonky.info
- Previews: https://{branch}.taskscore.pages.dev

## Troubleshooting tools
- `bun run get-xcontest-task` - Download task from XContest
