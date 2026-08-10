# Track-less pilots earn no leading points

Track-less pilots (manual flights, issue #306) earn no leading points
instead of crashing the scorer. A manual flight has no tracklog, so it
carries no leading aggregate/fixes/sequence; scoreFlights now treats such
a flight as LC = Infinity (0 leading points) rather than throwing. Only
affects leading-enabled tasks with manual flights — which the new
per-category HG default (leading on) made reachable.
