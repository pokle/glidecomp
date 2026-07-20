-- Indexes for per-pilot flight lookups ("My Flights" competition-flights
-- list: GET /api/comp/pilot/flights).
--
-- The lookup walks pilot → comp_pilot → task_track / task_manual_flight.
-- Before this migration neither hop was indexed from the pilot side:
-- comp_pilot's only index is the partial unique (comp_id, pilot_id) —
-- comp_id-first, so useless for "all registrations of one pilot" — and the
-- flight tables' unique (task_id, comp_pilot_id) indexes are task_id-first.
-- Each request would full-scan both flight tables.

CREATE INDEX "idx_comp_pilot_by_pilot"
  ON comp_pilot(pilot_id) WHERE pilot_id IS NOT NULL;

CREATE INDEX "idx_task_track_by_pilot"
  ON task_track(comp_pilot_id);

CREATE INDEX "idx_task_manual_flight_by_pilot"
  ON task_manual_flight(comp_pilot_id);
