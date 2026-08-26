import crypto from 'node:crypto';

export const TEST_SECRET = 'test_webhook_secret_token';

/**
 * Produce the signature Zoom would send for a given raw body and timestamp.
 * Mirrors Zoom's documented scheme: HMAC-SHA256 over `v0:{timestamp}:{body}`.
 */
export function signBody(rawBody, timestamp, secret = TEST_SECRET) {
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const hmac = crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
  return `v0=${hmac}`;
}

/** Seconds-since-epoch string, as Zoom sends in x-zm-request-timestamp. */
export function nowSeconds(offsetSeconds = 0) {
  return String(Math.floor(Date.now() / 1000) + offsetSeconds);
}

/**
 * Build a signed webhook delivery: raw bytes plus the headers Zoom would set.
 * Returns the raw Buffer so tests can prove verification uses exact bytes.
 */
export function signedDelivery(payloadObject, { secret = TEST_SECRET, timestamp = nowSeconds() } = {}) {
  const rawBody = Buffer.from(JSON.stringify(payloadObject), 'utf8');
  return {
    rawBody,
    headers: {
      'x-zm-request-timestamp': timestamp,
      'x-zm-signature': signBody(rawBody, timestamp, secret),
    },
  };
}

export function rtmsStartedPayload(overrides = {}) {
  return {
    event: 'meeting.rtms_started',
    event_ts: 1756200000000,
    payload: {
      meeting_uuid: 'meeting-uuid-aaa',
      rtms_stream_id: 'stream-id-111',
      server_urls: 'wss://rtms.example.zoom.us',
      signature: 'zoom-supplied-join-signature',
      ...overrides,
    },
  };
}

export function rtmsStoppedPayload(overrides = {}) {
  return {
    event: 'meeting.rtms_stopped',
    event_ts: 1756200600000,
    payload: {
      meeting_uuid: 'meeting-uuid-aaa',
      rtms_stream_id: 'stream-id-111',
      ...overrides,
    },
  };
}

export function urlValidationPayload(plainToken = 'plain-token-abc123') {
  return {
    event: 'endpoint.url_validation',
    event_ts: 1756200000000,
    payload: { plainToken },
  };
}
