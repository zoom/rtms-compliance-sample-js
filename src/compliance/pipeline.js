/**
 * Per-meeting screening pipeline.
 *
 * Wires the pieces together for one meeting: screen every segment, adjudicate
 * only the candidates, broadcast, escalate, and append to the audit chain.
 *
 * The pack is pinned when the pipeline is created and never swapped mid
 * meeting. Screening the first half of a call under one rule set and the
 * second half under another produces an audit record nobody can interpret.
 */
import { createScreener } from './screen.js';
import { createDisclosureTracker } from './disclosures.js';
import { adjudicate } from './adjudicate.js';
import { notifySupervisor } from '../api/supervisor.js';

/** How much prior transcript the model sees with each candidate. */
const CONTEXT_WINDOW_MS = 30_000;

/** Keep the tail of the transcript in memory for context and disclosures. */
const MAX_BUFFERED_SEGMENTS = 400;

export function createPipeline({
  meetingId,
  pack,
  config,
  llm,
  hub,
  auditChain,
  representativeUserId,
  logger = console,
}) {
  const screener = createScreener(pack, {
    suppressionWindowSeconds: config.ruleSuppressionWindowSeconds,
  });
  const disclosures = createDisclosureTracker(pack, { representativeUserId });
  const rulesById = new Map(pack.prohibited.map((rule) => [rule.id, rule]));

  const segments = [];
  const alerts = [];

  function contextFor(segment) {
    const since = segment.tStartMs - CONTEXT_WINDOW_MS;
    return segments
      .filter((s) => s.tStartMs >= since)
      .map((s) => `${s.speakerLabel}: ${s.text}`)
      .join('\n');
  }

  function publishState() {
    hub.setMeetingState(meetingId, { alerts, disclosures: disclosures.state() });
  }

  async function handleCandidate(candidate, segment) {
    const rule = rulesById.get(candidate.ruleId);

    const alert = await adjudicate({
      candidate,
      rule,
      context: contextFor(segment),
      llm,
      timeoutMs: config.llmTimeoutMs,
      modelId: config.llmModel,
      logger,
    });

    alerts.push(alert);
    publishState();
    hub.broadcastAlert(meetingId, alert);

    await auditChain.append(meetingId, {
      id: `${meetingId}:${alert.ruleId}:${alert.seqNo}`,
      kind: 'alert',
      seqNo: alert.seqNo,
      ruleId: alert.ruleId,
      rulePackVersion: pack.id,
      severity: alert.severity,
      quote: alert.quote,
      verdict: alert.adjudicated ? String(alert.violation) : 'unadjudicated',
      modelId: alert.modelId,
      occurredAt: segment.tStartMs,
    });

    // Escalation is best effort and must never interrupt screening.
    await notifySupervisor(alert, {
      webhookUrl: config.supervisorWebhookUrl,
      meetingId,
      logger,
    });
  }

  const disclosureTimer = setInterval(() => {
    const changes = disclosures.evaluate(segments);
    if (changes.length === 0) return;

    publishState();
    hub.broadcastDisclosureState(meetingId, disclosures.state());

    for (const change of changes) {
      auditChain
        .append(meetingId, {
          id: `${meetingId}:disclosure:${change.id}`,
          kind: 'disclosure',
          seqNo: change.seqNo,
          ruleId: change.id,
          rulePackVersion: pack.id,
          severity: change.severity,
          quote: change.quote,
          verdict: 'satisfied',
          occurredAt: Date.now(),
        })
        .catch((err) => logger.error?.(`failed to record disclosure ${change.id}: ${err.message}`));
    }
  }, config.disclosureIntervalSeconds * 1000);

  // Do not hold the process open on this interval alone.
  disclosureTimer.unref?.();

  return {
    /** Called for every normalized transcript segment. */
    onSegment(segment) {
      segments.push(segment);
      if (segments.length > MAX_BUFFERED_SEGMENTS) segments.shift();

      hub.broadcastSegment(meetingId, segment);

      // Deterministic pass is synchronous and inline; it is fast enough.
      const candidates = screener.screen(segment, segment.tStartMs);

      // Adjudication is not. Fire it off without blocking the next segment.
      for (const candidate of candidates) {
        handleCandidate(candidate, segment).catch((err) =>
          logger.error?.(`screening pipeline error for ${candidate.ruleId}: ${err.message}`),
        );
      }
    },

    async recordCoverageGap(timestamp) {
      await auditChain.append(meetingId, {
        id: `${meetingId}:gap:${timestamp}`,
        kind: 'coverage_gap',
        rulePackVersion: pack.id,
        severity: 'high',
        verdict: 'coverage_gap',
        occurredAt: timestamp,
      });
    },

    stop() {
      clearInterval(disclosureTimer);
    },

    snapshot: () => ({ alerts, disclosures: disclosures.state() }),
  };
}
