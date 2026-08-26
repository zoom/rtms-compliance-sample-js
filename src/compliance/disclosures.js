/**
 * Required-disclosure tracking.
 *
 * Two rules here are compliance requirements rather than implementation
 * preferences:
 *
 * 1. Only the representative can satisfy a disclosure. A client who happens
 *    to say "I know this is being recorded" does not discharge the
 *    representative of the obligation to disclose it.
 * 2. A satisfied disclosure never reverts. The obligation was met at a point
 *    in time and the transcript proves it. Later contradictions are their own
 *    finding, not an erasure of this one.
 */

export const DISCLOSURE_STATE = Object.freeze({
  PENDING: 'pending',
  SATISFIED: 'satisfied',
});

function normalizeForMatching(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {object} pack compiled pack from loadPack()
 * @param {{representativeUserId: number|string}} options
 */
export function createDisclosureTracker(pack, { representativeUserId } = {}) {
  const state = new Map(
    pack.requiredDisclosures.map((disclosure) => [
      disclosure.id,
      {
        id: disclosure.id,
        severity: disclosure.severity,
        prompt: disclosure.prompt,
        status: DISCLOSURE_STATE.PENDING,
        quote: null,
        seqNo: null,
      },
    ]),
  );

  const byId = new Map(pack.requiredDisclosures.map((d) => [d.id, d]));

  return {
    /**
     * Evaluate transcript segments against the pending disclosures.
     *
     * Called on an interval rather than per segment: this walks every pending
     * disclosure against every supplied segment, and the panel does not need
     * sub-second precision on a checklist.
     *
     * @param {Array<object>} segments
     * @returns {Array<object>} only the disclosures that transitioned
     */
    evaluate(segments = []) {
      const changes = [];

      for (const segment of segments) {
        // A disclosure is an obligation on the representative. Anyone else
        // reciting the words is not the representative disclosing them.
        if (representativeUserId !== undefined && segment.speakerId !== representativeUserId) {
          continue;
        }

        const text = normalizeForMatching(segment.text);
        if (text === '') continue;

        for (const entry of state.values()) {
          if (entry.status === DISCLOSURE_STATE.SATISFIED) continue;

          const disclosure = byId.get(entry.id);
          const matched = disclosure.patterns.some((pattern) => pattern.test(text));
          if (!matched) continue;

          entry.status = DISCLOSURE_STATE.SATISFIED;
          entry.quote = segment.text;
          entry.seqNo = segment.seqNo;
          changes.push({ ...entry });
        }
      }

      return changes;
    },

    /** Current checklist, safe to serialize to the panel. */
    state() {
      return [...state.values()].map((entry) => ({ ...entry }));
    },

    /** High-severity obligations still outstanding, for the late-meeting nudge. */
    pendingHighSeverity() {
      return [...state.values()]
        .filter((e) => e.status === DISCLOSURE_STATE.PENDING && e.severity === 'high')
        .map((entry) => ({ ...entry }));
    },
  };
}
