/**
 * Stage two of screening: context adjudication by an LLM.
 *
 * Only candidates from the deterministic pass arrive here. The model's job is
 * narrow: decide whether a match is a real violation in context, and draft the
 * correction. It cannot introduce new alerts and it cannot erase the
 * deterministic match, which is why the rule id survives every code path
 * below including every failure path.
 *
 * Bump PROMPT_VERSION whenever the prompt text changes. It is stamped on every
 * audit record so a reviewer can tell which prompt produced a verdict.
 */

export const PROMPT_VERSION = 'compliance-adjudicate-v1';

export function buildPrompt({ rule, candidate, context }) {
  return `You are a compliance reviewer for a regulated firm.
A deterministic rule matched a phrase in a live client meeting.
Decide whether it is a real violation in context.

Rule: ${rule.id} (${rule.severity})
Approved guidance: ${rule.guidance}
Matched phrase: "${candidate.matchedText}"
Prior 30 seconds: ${context}

Return JSON only:
{
  "violation": true | false,
  "confidence": 0.0 - 1.0,
  "rationale": "one sentence citing the transcript",
  "suggested_language": "what the representative should say now"
}

Mark violation false when the phrase is quoted, negated, or spoken by the client.`;
}

/**
 * Extract a verdict from raw model output.
 *
 * Models add markdown fences and preambles even when told not to. Tolerating
 * that is cheaper than losing an alert to a formatting quirk.
 *
 * @throws {Error} when no usable JSON object is present
 */
export function parseVerdict(raw) {
  const text = String(raw ?? '').trim();

  // Prefer a fenced block; fall back to the first balanced-looking object.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced
    ? fenced[1].trim()
    : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);

  if (!candidate || !candidate.startsWith('{')) {
    throw new Error(`model output contained no JSON object: ${text.slice(0, 120)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new Error(`model output was not valid JSON: ${err.message}`, { cause: err });
  }

  if (typeof parsed.violation !== 'boolean') {
    throw new Error('model output is missing a boolean "violation" field');
  }

  return {
    violation: parsed.violation,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    suggestedLanguage:
      typeof parsed.suggested_language === 'string' ? parsed.suggested_language : '',
  };
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`adjudication timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Adjudicate one candidate.
 *
 * Never throws and never returns null. A model that is slow, broken, or
 * offline degrades the alert to unadjudicated; it does not suppress it.
 * Dropping the alert here would mean a live compliance gap goes unreported
 * because a third-party API had a bad minute.
 *
 * @returns {Promise<object>} alert
 */
/**
 * The alert when adjudication is turned off. `adjudication: 'off'` tells the
 * panel there is no verdict to show, pending or otherwise.
 */
export function ruleOnlyAlert({ candidate, rule }) {
  return {
    ruleId: candidate.ruleId,
    severity: candidate.severity,
    quote: candidate.matchedText,
    seqNo: candidate.seqNo,
    guidance: rule.guidance,
    violation: null,
    rationale: null,
    suggestedLanguage: rule.guidance,
    adjudicated: false,
    adjudication: 'off',
  };
}

/**
 * The alert as it stands the moment the rule matches, before any model call.
 * Sent to the panel immediately so the rep sees it while the words are still
 * fresh; the adjudicated version replaces it when the verdict arrives.
 */
export function provisionalAlert({ candidate, rule, modelId }) {
  return {
    ruleId: candidate.ruleId,
    severity: candidate.severity,
    quote: candidate.matchedText,
    seqNo: candidate.seqNo,
    guidance: rule.guidance,
    modelId,
    promptVersion: PROMPT_VERSION,
    violation: null,
    confidence: 0,
    rationale: 'Checking context…',
    suggestedLanguage: rule.guidance,
    adjudicated: false,
    pending: true,
  };
}

export async function adjudicate({
  candidate,
  rule,
  context,
  llm,
  timeoutMs = 5000,
  modelId,
  logger = console,
}) {
  const base = {
    ruleId: candidate.ruleId,
    severity: candidate.severity,
    quote: candidate.matchedText,
    seqNo: candidate.seqNo,
    guidance: rule.guidance,
    modelId,
    promptVersion: PROMPT_VERSION,
  };

  try {
    const raw = await withTimeout(llm(buildPrompt({ rule, candidate, context })), timeoutMs);
    const verdict = parseVerdict(raw);

    return {
      ...base,
      violation: verdict.violation,
      confidence: verdict.confidence,
      rationale: verdict.rationale,
      suggestedLanguage: verdict.suggestedLanguage || rule.guidance,
      adjudicated: true,
    };
  } catch (err) {
    logger.warn?.(
      `adjudication failed for rule ${candidate.ruleId} at seqNo ${candidate.seqNo}: ${err.message}. Emitting unadjudicated alert.`,
    );

    return {
      ...base,
      // Not "false". The deterministic rule matched; we simply could not
      // confirm intent. The panel renders this as flagged, unverified.
      violation: null,
      confidence: 0,
      rationale: `Not adjudicated: ${err.message}`,
      suggestedLanguage: rule.guidance,
      adjudicated: false,
    };
  }
}
