/**
 * Supervisor escalation.
 *
 * Fire-and-forget by design in this sample. A failed escalation must never
 * break the screening path, so this swallows errors and logs them. That is
 * also its main production gap: see the README on replacing this with a
 * durable outbox, because "we tried to page the supervisor and the POST
 * failed" is not a defensible answer to a regulator.
 */

/** Only these severities page a human mid-meeting. */
const ESCALATE_SEVERITIES = new Set(['high']);

/**
 * @param {object} alert
 * @param {object} options
 * @param {string} [options.webhookUrl] unset means escalation is disabled
 * @param {Function} [options.fetchImpl] injectable for tests
 * @param {string} options.meetingId
 */
export async function notifySupervisor(
  alert,
  { webhookUrl, fetchImpl = globalThis.fetch, meetingId, logger = console } = {},
) {
  if (!webhookUrl) return { escalated: false, reason: 'no webhook configured' };
  if (!ESCALATE_SEVERITIES.has(alert?.severity)) {
    return { escalated: false, reason: `severity ${alert?.severity} does not escalate` };
  }

  const body = JSON.stringify({
    meetingId,
    ruleId: alert.ruleId,
    severity: alert.severity,
    quote: alert.quote,
    seqNo: alert.seqNo,
    violation: alert.violation,
    confidence: alert.confidence,
    adjudicated: alert.adjudicated,
    suggestedLanguage: alert.suggestedLanguage,
    occurredAt: new Date().toISOString(),
  });

  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    if (!response?.ok) {
      logger.error?.(
        `supervisor webhook returned ${response?.status} for rule ${alert.ruleId}; alert was still delivered in-meeting`,
      );
      return { escalated: false, reason: `http ${response?.status}` };
    }

    return { escalated: true };
  } catch (err) {
    // Never rethrow. This runs alongside live screening.
    logger.error?.(
      `supervisor webhook failed for rule ${alert.ruleId}: ${err.message}; alert was still delivered in-meeting`,
    );
    return { escalated: false, reason: err.message };
  }
}
