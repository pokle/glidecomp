# Two-step tolerance-band penetrations

Two-step tolerance-band penetrations anchor to the nominal radius —
when the fix pair that crosses the detection edge (outer band edge, or
inner for an EXIT start) doesn't straddle the nominal radius, the
crossing now anchors to the fix pair within the band episode that
does, instead of clamping to the band-edge fix and mislabelling the
crossing as tolerance-credited. Reaching times/positions shift by up
to one fix interval; toleranceCredited is only set when the pilot
genuinely never crossed the nominal radius.
