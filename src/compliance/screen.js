/**
 * Stage one of screening: the deterministic pass.
 *
 * This runs inline on every transcript segment, so it must stay cheap. It is
 * also the half of an alert that is reproducible: an auditor can re-run a
 * pinned pack version over a stored transcript and get byte-identical
 * matches. That property is why stage one exists at all rather than sending
 * everything to a model.
 */

/**
 * Collapse whitespace runs so a phrase split across a pause still matches,
 * while leaving punctuation intact. "risk. free" must not satisfy a rule
 * looking for "risk free"; those are two different statements.
 */
function normalizeForMatching(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {object} pack compiled pack from loadPack()
 * @param {{suppressionWindowSeconds: number}} options
 */
export function createScreener(pack, { suppressionWindowSeconds = 60 } = {}) {
  const windowMs = suppressionWindowSeconds * 1000;

  // ruleId -> timestamp of the last candidate we emitted for it. A rep who
  // says "guaranteed return" four times in one breath should get one alert,
  // not four.
  const lastEmittedAt = new Map();

  return {
    /**
     * @param {object} segment normalized transcript segment
     * @param {number} [nowMs] evaluation time, injectable for tests
     * @returns {Array<{ruleId: string, severity: string, matchedText: string, seqNo: number}>}
     */
    screen(segment, nowMs = Date.now()) {
      const text = normalizeForMatching(segment?.text);
      if (text === '') return [];

      const candidates = [];

      for (const rule of pack.prohibited) {
        const previous = lastEmittedAt.get(rule.id);
        if (previous !== undefined && nowMs - previous <= windowMs) continue;

        for (const pattern of rule.patterns) {
          const match = pattern.exec(text);
          if (!match) continue;

          candidates.push({
            ruleId: rule.id,
            severity: rule.severity,
            matchedText: match[0],
            seqNo: segment.seqNo,
          });
          lastEmittedAt.set(rule.id, nowMs);
          break; // one candidate per rule, however many of its patterns hit
        }
      }

      return candidates;
    },

    /** Exposed for the panel: which rules are currently muted. */
    suppressedRuleIds(nowMs = Date.now()) {
      return [...lastEmittedAt.entries()]
        .filter(([, at]) => nowMs - at <= windowMs)
        .map(([ruleId]) => ruleId);
    },
  };
}
