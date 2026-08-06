/**
 * "Where the points went" — the ledger that answers why this pilot is not
 * first: component by component against the class leader, or, for the leader
 * themselves, against the day's own per-component offer. The winner's
 * headline note is the one-sentence form of that second ledger.
 */

import type {
  ScoreExplanationItem,
  ScoreExplanationSection,
  ScoreEntryInput,
  ClassContextInput,
  ClassPilotInput,
} from '../score-explanation-types';
import { fmtPoints, duration } from '../score-explanation-format';

/**
 * "Where the points went" — this pilot against the best score in the class,
 * component by component.
 *
 * The header says "ranked #9" and the page then never mentions it again, so
 * the reader's actual question — why am I 9th and not 3rd — goes unanswered
 * beside a full accounting of points they cannot compare to anything. Every
 * number here is already in the class context; nothing is recomputed.
 *
 * The comparison is against the class LEADER, not the best value per
 * component. A per-component best would assemble a pilot who does not exist
 * and whose "total" no one scored — the honest question is what separates
 * this pilot from the person who won the day.
 *
 * The leader (or a pilot tied at the top) has no gap to anyone, but they
 * still arrive with the same question in a different frame — full validity,
 * why not full points? — so they get the vs-the-day variant from
 * {@link buildPointsLeftSection} instead of nothing. Returns null only when
 * the payload carries no comparable pilots, or the leader swept the day.
 */
export function buildComparisonSection(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
): ScoreExplanationSection | null {
  // Only pilots the payload carries point components for — older cached
  // bodies narrow to the four validity fields and cannot be compared.
  const scored = classContext.pilots.filter(
    (p) => p.total_score !== undefined && !p.track_excluded,
  );
  if (scored.length === 0) return null;
  const leader = scored.reduce((best, p) =>
    (p.total_score ?? 0) > (best.total_score ?? 0) ? p : best,
  );
  const leaderTotal = leader.total_score ?? 0;
  const gap = leaderTotal - entry.total_score;
  // Nobody ahead — the question flips from "the winner has what I don't" to
  // "the day offered what I didn't take".
  if (gap <= 0.05) return buildPointsLeftSection(entry, classContext, scored);
  if (scored.length < 2) return null;

  const rows: Array<{ id: string; label: string; mine: number; theirs: number }> = [
    {
      id: 'distance',
      label: 'Distance',
      mine: entry.distance_points,
      theirs: leader.distance_points ?? 0,
    },
    {
      id: 'time',
      label: 'Time',
      mine: entry.time_points,
      theirs: leader.time_points ?? 0,
    },
  ];
  if (classContext.available_points.leading > 0) {
    rows.push({
      id: 'leading',
      label: 'Leading',
      mine: entry.leading_points,
      theirs: leader.leading_points ?? 0,
    });
  }
  if (classContext.available_points.arrival > 0) {
    rows.push({
      id: 'arrival',
      label: 'Arrival',
      mine: entry.arrival_points,
      theirs: leader.arrival_points ?? 0,
    });
  }

  // Penalties are points lost to the leader like any component, and a ledger
  // that omits them cannot reconcile with the gap it claims to explain. BOTH
  // sides are derived from the identity the payload guarantees — components −
  // total — rather than from the published penalty figures: a §12.2/§12.4
  // floor makes the published deduction bigger than its net effect (the
  // archive's jump-the-gun cases were 74 points apart), and the ledger's
  // business is the net. Tolerance for the total's 0.1 rounding.
  const minePenalty =
    entry.distance_points +
    entry.time_points +
    entry.leading_points +
    entry.arrival_points -
    entry.total_score;
  const leaderPenalty =
    (leader.distance_points ?? 0) +
    (leader.time_points ?? 0) +
    (leader.leading_points ?? 0) +
    (leader.arrival_points ?? 0) -
    leaderTotal;
  const publishedPenalty =
    entry.penalty_points + (entry.jump_the_gun_penalty ?? 0);
  if (Math.abs(minePenalty) > 0.1 || Math.abs(leaderPenalty) > 0.1) {
    rows.push({
      id: 'penalty',
      label: 'Penalties',
      mine: Math.abs(minePenalty) > 0.1 ? -minePenalty : 0,
      theirs: Math.abs(leaderPenalty) > 0.1 ? -leaderPenalty : 0,
    });
  }

  // Points prefixed with the proper minus sign — the ledger's negative values
  // (penalties) must not print a bare hyphen beside typeset minuses elsewhere.
  const signedPts = (n: number) =>
    n < -0.05 ? `−${fmtPoints(-n)}` : fmtPoints(n);

  const items: ScoreExplanationItem[] = rows.map((r) => {
    const diff = r.mine - r.theirs;
    // The ledger states the penalty's NET effect; when a floor made that
    // smaller than the published deduction, say where the full figure lives.
    const floorNote =
      r.id === 'penalty' && Math.abs(minePenalty - publishedPenalty) > 0.3
        ? ' — the net effect after the scoring floor; the penalty section shows the full deduction'
        : '';
    return {
      id: `gap-${r.id}`,
      text: r.label,
      value:
        Math.abs(diff) < 0.05
          ? 'level'
          : `${diff > 0 ? '+' : '−'}${fmtPoints(Math.abs(diff))} pts`,
      detail: `you ${signedPts(r.mine)}, the leader ${signedPts(r.theirs)}${floorNote}`,
      emphasis: Math.abs(diff) < 0.05 ? 'muted' : undefined,
    };
  });

  // Name the component that cost the most, when one clearly dominates. This
  // is the sentence the reader came for, and it is a fact about the
  // arithmetic — not advice about how to fly.
  const losses = rows
    .map((r) => ({
      label: LEDGER_TERMS[r.label.toLowerCase()] ?? r.label.toLowerCase(),
      lost: r.theirs - r.mine,
    }))
    .filter((r) => r.lost > 0.05)
    .sort((a, b) => b.lost - a.lost);
  const gains = rows
    .map((r) => ({
      label: LEDGER_TERMS[r.label.toLowerCase()] ?? r.label.toLowerCase(),
      won: r.mine - r.theirs,
    }))
    .filter((r) => r.won > 0.05)
    .sort((a, b) => b.won - a.won);
  const dominant =
    losses.length > 0 && losses[0].lost >= 0.75 * gap ? losses[0] : null;

  let gapDetail: string;
  if (dominant && dominant.lost > gap + 0.05 && gains.length > 0) {
    // A loss bigger than the whole gap: points won elsewhere offset it, and
    // "85.6 of 38.9 points" would read as an arithmetic error — say what
    // actually happened instead, leading with the deficit rather than the
    // "cost", which read as the flying style being penalised. (Jon Durand's
    // case: fastest through the speed section, lost the day on leading.)
    const wonBack = gains.reduce((s, g) => s + g.won, 0);
    // The reader in this exact spot — a big leading-points deficit offset by
    // a time-points win — is by construction someone who was fast but not in
    // front, the pilot most likely to misread the component's name.
    const leadingNote =
      dominant.label === 'leading-points' &&
      gains.some((g) => g.label === 'time-points')
        ? ' Leading-points reward being out front on the clock, which the fastest pilot often isn’t.'
        : '';
    gapDetail =
      dominant.label === 'penalties'
        ? `Penalties cost you ${fmtPoints(dominant.lost)} — more than the whole gap — and you won ${fmtPoints(wonBack)} back on ${listLabels(gains.map((g) => g.label))}.`
        : `You took ${fmtPoints(dominant.lost)} fewer ${dominant.label} than the leader — more than the whole gap — and won ${fmtPoints(wonBack)} back on ${listLabels(gains.map((g) => g.label))}.${leadingNote}`;
  } else if (dominant) {
    gapDetail =
      losses.length === 1
        ? `All of the gap is ${dominant.label}.`
        : `Most of the gap — ${fmtPoints(dominant.lost)} of ${fmtPoints(gap)} points — is ${dominant.label}.`;
  } else if (losses.length > 0) {
    // No single culprit — but a bare count is a dead end on a page where
    // every other line substitutes its numbers, so name them, largest first.
    gapDetail = `Spread across ${listLabels(losses.map((l) => l.label))} — ${losses[0].label} the largest, at ${fmtPoints(losses[0].lost)}.`;
  } else {
    // A gap the rows cannot account for: the leader's breakdown is missing
    // from this payload. State that rather than crash or invent a culprit.
    gapDetail = 'The gap is not in the components above — the leader’s published breakdown does not carry it.';
  }

  items.push({
    id: 'gap-total',
    text: `Behind ${leader.pilot_name ?? 'the class leader'}`,
    value: `−${fmtPoints(gap)} pts`,
    detail: gapDetail,
  });

  return {
    id: 'comparison',
    title: 'Where the points went',
    summary: `Your ${fmtPoints(entry.total_score)} against the ${fmtPoints(
      leaderTotal,
    )} that won the class.`,
    docHref: '/scoring/gap#scoring-components',
    items,
  };
}

/**
 * How a ledger sentence names a component: the hyphenated points term,
 * never the bare activity noun. "The gap is leading" parses as being out
 * front — the exact opposite of what the sentence means — and "leading
 * cost you 85.6 points" reads as the act of leading being penalised.
 * "Leading-points" cannot be misread as either. Penalties are already
 * unambiguous and stay themselves.
 */
const LEDGER_TERMS: Record<string, string> = {
  distance: 'distance-points',
  time: 'time-points',
  leading: 'leading-points',
  arrival: 'arrival-points',
  penalties: 'penalties',
};

/** "time-points", "time-points and arrival-points", "…, … and …". */
function listLabels(labels: string[]): string {
  return labels.length <= 1
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * What separates this pilot's published points from the day's per-component
 * offer, penalties included — the "left on the day" ledger shared by the
 * leader's comparison section and the winner's headline note.
 */
function shortfallsAgainstOffer(
  entry: ScoreEntryInput,
  ap: ClassContextInput['available_points'],
): Array<{ label: string; lost: number }> {
  const rows = [
    { label: 'distance-points', lost: ap.distance - entry.distance_points },
    { label: 'time-points', lost: ap.time - entry.time_points },
    ...(ap.leading > 0
      ? [{ label: 'leading-points', lost: ap.leading - entry.leading_points }]
      : []),
    ...(ap.arrival > 0
      ? [{ label: 'arrival-points', lost: ap.arrival - entry.arrival_points }]
      : []),
    {
      // Net penalty effect, derived from components − total, so a §12.2/§12.4
      // floor never overstates what the deduction actually cost.
      label: 'penalties',
      lost:
        entry.distance_points +
        entry.time_points +
        entry.leading_points +
        entry.arrival_points -
        entry.total_score,
    },
  ];
  return rows.filter((r) => r.lost > 0.05).sort((a, b) => b.lost - a.lost);
}

/**
 * The leader's version of "where the points went": nobody out-scored them,
 * so the comparison that answers their actual question — the day had full
 * validity, why didn't I get full points? — is against the day's own offer,
 * component by component. One pilot genuinely could take it all (in goal,
 * fastest, best leading coefficient, first to ESS), so the per-component
 * offer is a real ceiling here, not the composite fiction a per-component
 * best across different pilots would be for everyone else.
 *
 * Where another pilot took a component's full points, they are named — that
 * is the sentence the winner came for ("your speed was not the fastest").
 */
function buildPointsLeftSection(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  /** The comparable pilots (total_score published, track not withheld). */
  scored: ClassPilotInput[],
): ScoreExplanationSection | null {
  const ap = classContext.available_points;
  const left = ap.total - entry.total_score;
  // A full sweep — nothing to explain.
  if (left <= 0.05) return null;

  // The pilot who took a component's full points, when one did and the
  // payload names them. Matched on the published points, not re-derived.
  const fullTaker = (
    points: (p: ClassPilotInput) => number | undefined,
    available: number,
  ): ClassPilotInput | undefined =>
    scored.find(
      (p) => p.pilot_name && Math.abs((points(p) ?? 0) - available) <= 0.05,
    );

  const items: ScoreExplanationItem[] = [];
  const row = (
    id: string,
    label: string,
    mine: number,
    offer: number,
    takerNote?: string,
  ) => {
    const short = offer - mine;
    const full = short <= 0.05;
    items.push({
      id: `left-${id}`,
      text: label,
      value: full ? 'full points' : `−${fmtPoints(short)} pts`,
      detail: `you ${fmtPoints(mine)} of ${fmtPoints(offer)} on offer${
        !full && takerNote ? takerNote : ''
      }`,
      emphasis: full ? 'muted' : undefined,
    });
  };

  // Every row is gated on a real offer: a nobody-in-goal HG day clamps the
  // time weight to zero, and "full points — you 0 of 0 on offer" is noise.
  if (ap.distance > 0) {
    row('distance', 'Distance', entry.distance_points, ap.distance);
  }
  if (ap.time > 0) {
    const fastest = fullTaker((p) => p.time_points, ap.time);
    row(
      'time',
      'Time',
      entry.time_points,
      ap.time,
      fastest
        ? ` — ${fastest.pilot_name} took the full time-points${
            fastest.speed_section_time
              ? ` in ${duration(fastest.speed_section_time)}`
              : ''
          }`
        : undefined,
    );
  }
  if (ap.leading > 0) {
    const bestLead = fullTaker((p) => p.leading_points, ap.leading);
    row(
      'leading',
      'Leading',
      entry.leading_points,
      ap.leading,
      bestLead ? ` — ${bestLead.pilot_name} took the full leading-points` : undefined,
    );
  }
  if (ap.arrival > 0) {
    const firstEss = fullTaker((p) => p.arrival_points, ap.arrival);
    row(
      'arrival',
      'Arrival',
      entry.arrival_points,
      ap.arrival,
      firstEss
        ? ` — ${firstEss.pilot_name} was first to the end of the speed section`
        : undefined,
    );
  }
  // Net penalty effect (components − total), so a §12.2/§12.4 floor never
  // overstates what the deduction actually cost.
  const penalties =
    entry.distance_points +
    entry.time_points +
    entry.leading_points +
    entry.arrival_points -
    entry.total_score;
  const publishedPenalty =
    entry.penalty_points + (entry.jump_the_gun_penalty ?? 0);
  if (penalties > 0.1) {
    items.push({
      id: 'left-penalty',
      text: 'Penalties',
      value: `−${fmtPoints(penalties)} pts`,
      detail:
        Math.abs(penalties - publishedPenalty) > 0.3
          ? 'The net effect after the scoring floor — the penalty section shows the full deduction.'
          : 'See the penalty section above.',
      emphasis: 'warning',
    });
  }

  // Name what the shortfall mostly is, when one component clearly dominates —
  // the same 75% threshold as the behind-the-leader variant.
  const losses = shortfallsAgainstOffer(entry, ap);
  const dominant =
    losses.length > 0 && losses[0].lost >= 0.75 * left ? losses[0] : null;
  // On a day nobody makes goal, the GAP weight split can sum to slightly more
  // than 1 (the time weight is clamped at zero — S7F §10, calculateWeights),
  // so the per-component offers overshoot the day total and the rows above
  // sum to more than the points actually left. Say so, rather than print a
  // share the rows visibly contradict.
  const shownOffers =
    ap.distance +
    ap.time +
    (ap.leading > 0 ? ap.leading : 0) +
    (ap.arrival > 0 ? ap.arrival : 0);
  const overshoot = shownOffers - ap.total;
  let leftDetail: string;
  if (overshoot > 0.2) {
    leftDetail = `The component offers sum to ${fmtPoints(shownOffers)} on a ${fmtPoints(ap.total)}-point day — with nobody in goal the GAP weights overshoot slightly — so the rows above come to more than the ${fmtPoints(left)} actually left.${dominant ? ` The biggest untaken offer is ${dominant.label}.` : ''}`;
  } else if (dominant && dominant.lost <= left + 0.05) {
    leftDetail =
      losses.length === 1
        ? `All of it is ${dominant.label}.`
        : `Most of it — ${fmtPoints(dominant.lost)} of ${fmtPoints(left)} points — is ${dominant.label}.`;
  } else if (losses.length > 0) {
    leftDetail = `Spread across ${listLabels(losses.map((l) => l.label))} — ${losses[0].label} the largest, at ${fmtPoints(losses[0].lost)}.`;
  } else {
    leftDetail = 'Display rounding — the components above account for it.';
  }
  items.push({
    id: 'left-total',
    text: 'Left on the day',
    value: `−${fmtPoints(left)} pts`,
    detail: leftDetail,
  });

  return {
    id: 'comparison',
    title: 'The points left on the day',
    summary: `Nobody out-scored you — so this compares your ${fmtPoints(
      entry.total_score,
    )} against the ${fmtPoints(ap.total)} the day offered.`,
    docHref: '/scoring/gap#scoring-components',
    items,
  };
}

/**
 * The winner's bridging sentence, shown under the headline: the one question
 * the day's leader arrives with — full validity, why not full points? — gets
 * answered before any scrolling. Everyone else's version of the question is
 * the gap to the leader, which the comparison section leads with, so this
 * returns undefined for them.
 */
export function buildWinnerHeadlineNote(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
): string | undefined {
  const scored = classContext.pilots.filter(
    (p) => p.total_score !== undefined && !p.track_excluded,
  );
  if (scored.length === 0) return undefined;
  const leaderTotal = Math.max(...scored.map((p) => p.total_score ?? 0));
  if (leaderTotal - entry.total_score > 0.05) return undefined;
  const ap = classContext.available_points;
  const left = ap.total - entry.total_score;
  if (left <= 0.05) return undefined;
  const losses = shortfallsAgainstOffer(entry, ap);
  const dominant =
    losses.length > 0 && losses[0].lost >= 0.75 * left ? losses[0] : null;
  // No share claim when the dominant shortfall exceeds the net left (weight
  // overshoot on a nobody-in-goal day, or a bonus) — the ledger explains it.
  const mostly =
    dominant && dominant.lost <= left + 0.05
      ? losses.length === 1
        ? ` — all of it ${dominant.label}`
        : ` — mostly ${dominant.label}`
      : '';
  let note = `Top of the class, but not a full sweep: of the ${fmtPoints(
    ap.total,
  )} points on offer, ${fmtPoints(left)} went untaken${mostly}.`;
  // When the shortfall is time, state the concrete fact behind it: how much
  // quicker the pilot who took the full time-points was.
  if (dominant?.label === 'time-points' && entry.speed_section_time !== null) {
    const fastest = scored.find(
      (p) =>
        p.speed_section_time != null &&
        Math.abs((p.time_points ?? 0) - ap.time) <= 0.05,
    );
    const behind =
      fastest?.speed_section_time != null
        ? entry.speed_section_time - fastest.speed_section_time
        : 0;
    if (behind > 0) {
      note += ` The fastest pilot through the speed section was ${duration(behind)} quicker.`;
    }
  }
  return note;
}
