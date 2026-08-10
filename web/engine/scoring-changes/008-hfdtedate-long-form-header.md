# Post-2015 HFDTEDATE long-form header parsing

Post-2015 HFDTEDATE long-form header parsing — the modern
`HFDTEDATE:150124,01` date header is now recognized. Previously it
failed both date regexes, leaving header.date undefined so every fix
was stamped with the parse-day's date (non-deterministic), corrupting
start gates, task-date checks, and timezone display for such files.
