/**
 * Zoom webhook verification and routing.
 *
 * `handleWebhook` is deliberately pure: raw bytes and headers in, a decision
 * out. No I/O, no SDK, no database. That keeps the security-critical path
 * fully testable and keeps the Express and RTMS SDK wiring thin.
 */
import crypto from 'node:crypto';

/** Zoom rejects deliveries older than five minutes; so do we. */
const REPLAY_WINDOW_SECONDS = 300;

const SIGNATURE_HEADER = 'x-zm-signature';
const TIMESTAMP_HEADER = 'x-zm-request-timestamp';

/**
 * Verify a Zoom webhook signature.
 *
 * The signature covers `v0:{timestamp}:{rawBody}`, where rawBody is the exact
 * bytes Zoom sent. Re-serializing a parsed body produces different bytes and
 * therefore a different HMAC, so callers must preserve the raw buffer. The
 * webhook route in server.js uses express.raw() for exactly this reason.
 *
 * @param {Buffer|string} rawBody exact request bytes
 * @param {string} timestamp value of x-zm-request-timestamp
 * @param {string} signature value of x-zm-signature
 * @param {string} secret webhook secret token
 * @returns {boolean}
 */
export function verifySignature(rawBody, timestamp, signature, secret) {
  return signatureFailure(rawBody, timestamp, signature, secret) === null;
}

/**
 * Why a signature does not verify, or null if it does. The reason is for the
 * server log only; the caller still gets a bare 401.
 */
export function signatureFailure(rawBody, timestamp, signature, secret) {
  if (!secret) return 'no webhook secret configured';
  if (!signature || !timestamp) return 'missing signature headers';

  const requestTimestamp = Number.parseInt(timestamp, 10);
  if (Number.isNaN(requestTimestamp)) return 'unparseable timestamp';

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - requestTimestamp) > REPLAY_WINDOW_SECONDS) {
    return `timestamp outside the ${REPLAY_WINDOW_SECONDS}s replay window`;
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected =
    'v0=' + crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');

  // timingSafeEqual throws on length mismatch, so compare lengths first. The
  // length of a signature is not a secret.
  const matches =
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

  return matches ? null : 'signature mismatch';
}

/**
 * Answer Zoom's endpoint URL validation challenge.
 *
 * Proves the endpoint holds the webhook secret without revealing it.
 *
 * @param {string} plainToken token from the challenge payload
 * @param {string} secret webhook secret token
 */
export function buildValidationResponse(plainToken, secret) {
  return {
    plainToken,
    encryptedToken: crypto.createHmac('sha256', secret).update(plainToken).digest('hex'),
  };
}

const IGNORE = { type: 'ignore' };
const unauthorized = (reason) => ({
  status: 401,
  body: { error: 'Unauthorized' },
  action: IGNORE,
  reason,
});

/**
 * Decide what to do with an inbound webhook delivery.
 *
 * @param {object} args
 * @param {Buffer} args.rawBody exact request bytes
 * @param {Record<string,string>} args.headers request headers, lowercased keys
 * @param {string} args.secret webhook secret token
 * @param {string} [args.clientId] this app's client ID, to explain a mismatch
 * @returns {{status: number, body: object, action: {type: string, payload?: object}, reason?: string}}
 */
export function handleWebhook({ rawBody, headers = {}, secret, clientId }) {
  let envelope;
  try {
    envelope = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
  } catch {
    // An unparseable body cannot be acted on, and echoing a parse error back
    // to an unauthenticated caller is free reconnaissance.
    return unauthorized('unparseable body');
  }

  if (envelope?.event === 'endpoint.url_validation') {
    // Validation deliveries carry no signature. Verifying first would make it
    // impossible to ever register the endpoint.
    const plainToken = envelope.payload?.plainToken;
    if (!plainToken) return unauthorized('validation request without plainToken');

    return {
      status: 200,
      body: buildValidationResponse(plainToken, secret),
      action: { type: 'url_validation' },
    };
  }

  const signature = headers[SIGNATURE_HEADER];
  const timestamp = headers[TIMESTAMP_HEADER];
  const failure = signatureFailure(rawBody, timestamp, signature, secret);
  if (failure) {
    // Zoom names the sending app in a clientid header. It is unauthenticated,
    // so it never decides anything, but when it differs from ours it is
    // almost always the reason the signature failed: .env holds another
    // app's credentials.
    const sender = headers.clientid;
    if (failure === 'signature mismatch' && sender && clientId && sender !== clientId) {
      return unauthorized(
        `signature mismatch: delivery is from app ${sender}, but ZM_RTMS_CLIENT is ${clientId}. ` +
          'ZM_RTMS_CLIENT, ZM_RTMS_SECRET, and ZM_RTMS_WEBHOOK_SECRET must all come from the app you installed.',
      );
    }
    return unauthorized(
      failure === 'signature mismatch'
        ? 'signature mismatch: ZM_RTMS_WEBHOOK_SECRET does not match the Secret Token on the app'
        : failure,
    );
  }

  const payload = envelope.payload ?? {};

  switch (envelope.event) {
    case 'meeting.rtms_started':
      return { status: 200, body: { status: 'ok' }, action: { type: 'stream_start', payload } };
    case 'meeting.rtms_stopped':
      return { status: 200, body: { status: 'ok' }, action: { type: 'stream_stop', payload } };
    default:
      // Verified but not ours. Acknowledge so Zoom stops retrying.
      return { status: 200, body: { status: 'ok' }, action: IGNORE };
  }
}
