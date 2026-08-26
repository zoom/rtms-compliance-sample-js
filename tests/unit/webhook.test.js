import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { verifySignature, buildValidationResponse, handleWebhook } from '../../src/rtms/webhook.js';
import {
  TEST_SECRET,
  signBody,
  nowSeconds,
  signedDelivery,
  rtmsStartedPayload,
  rtmsStoppedPayload,
  urlValidationPayload,
} from '../helpers/signing.js';

// Acceptance criteria 1-6.

describe('verifySignature', () => {
  test('should accept a signature computed over v0:{timestamp}:{rawBody}', () => {
    const rawBody = Buffer.from('{"event":"meeting.rtms_started"}', 'utf8');
    const timestamp = nowSeconds();

    assert.equal(verifySignature(rawBody, timestamp, signBody(rawBody, timestamp), TEST_SECRET), true);
  });

  test('should reject a signature computed with a different secret', () => {
    const rawBody = Buffer.from('{"event":"meeting.rtms_started"}', 'utf8');
    const timestamp = nowSeconds();
    const forged = signBody(rawBody, timestamp, 'wrong_secret_entirely');

    assert.equal(verifySignature(rawBody, timestamp, forged, TEST_SECRET), false);
  });

  test('should reject a signature whose length differs from the expected value', () => {
    const rawBody = Buffer.from('{}', 'utf8');
    const timestamp = nowSeconds();

    // A length mismatch must be caught before timingSafeEqual, which throws
    // on unequal buffer lengths.
    assert.equal(verifySignature(rawBody, timestamp, 'v0=deadbeef', TEST_SECRET), false);
  });

  test('should reject a missing signature', () => {
    assert.equal(verifySignature(Buffer.from('{}'), nowSeconds(), undefined, TEST_SECRET), false);
  });

  test('should reject a missing timestamp', () => {
    const rawBody = Buffer.from('{}');
    assert.equal(verifySignature(rawBody, undefined, signBody(rawBody, '123'), TEST_SECRET), false);
  });

  test('should reject a non-numeric timestamp', () => {
    const rawBody = Buffer.from('{}');
    assert.equal(verifySignature(rawBody, 'not-a-number', signBody(rawBody, 'not-a-number'), TEST_SECRET), false);
  });

  test('should reject a timestamp older than the 300 second replay window', () => {
    const rawBody = Buffer.from('{}');
    const stale = nowSeconds(-301);

    assert.equal(verifySignature(rawBody, stale, signBody(rawBody, stale), TEST_SECRET), false);
  });

  test('should accept a timestamp inside the 300 second replay window', () => {
    const rawBody = Buffer.from('{}');
    const recent = nowSeconds(-299);

    assert.equal(verifySignature(rawBody, recent, signBody(rawBody, recent), TEST_SECRET), true);
  });

  test('should reject a timestamp too far in the future', () => {
    const rawBody = Buffer.from('{}');
    const future = nowSeconds(301);

    assert.equal(verifySignature(rawBody, future, signBody(rawBody, future), TEST_SECRET), false);
  });

  test('should verify against exact raw bytes, not a re-serialization of the parsed body', () => {
    // Zoom signs the bytes it sent. This body has spacing that JSON.stringify
    // of the parsed object would not reproduce, so a re-serializing
    // implementation computes a different HMAC and fails this test.
    const rawBody = Buffer.from('{"event": "meeting.rtms_started",  "event_ts": 1}', 'utf8');
    const timestamp = nowSeconds();
    const signature = signBody(rawBody, timestamp);

    assert.equal(verifySignature(rawBody, timestamp, signature, TEST_SECRET), true);
    assert.equal(
      verifySignature(Buffer.from(JSON.stringify(JSON.parse(rawBody.toString()))), timestamp, signature, TEST_SECRET),
      false,
      'a re-serialized body must not verify against the original signature',
    );
  });
});

describe('buildValidationResponse', () => {
  test('should return the plainToken and its HMAC-SHA256 under the webhook secret', () => {
    const plainToken = 'plain-token-abc123';
    const expected = crypto.createHmac('sha256', TEST_SECRET).update(plainToken).digest('hex');

    assert.deepEqual(buildValidationResponse(plainToken, TEST_SECRET), {
      plainToken,
      encryptedToken: expected,
    });
  });

  test('should produce a 64 character hex digest', () => {
    const { encryptedToken } = buildValidationResponse('abc', TEST_SECRET);

    assert.match(encryptedToken, /^[0-9a-f]{64}$/);
  });
});

describe('handleWebhook', () => {
  test('should answer endpoint.url_validation with 200 and the token pair', () => {
    const payload = urlValidationPayload('plain-token-abc123');
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');

    const result = handleWebhook({ rawBody, headers: {}, secret: TEST_SECRET });

    assert.equal(result.status, 200);
    assert.equal(result.body.plainToken, 'plain-token-abc123');
    assert.equal(
      result.body.encryptedToken,
      crypto.createHmac('sha256', TEST_SECRET).update('plain-token-abc123').digest('hex'),
    );
    assert.equal(result.action.type, 'url_validation');
  });

  test('should answer endpoint.url_validation without requiring a signature', () => {
    // Validation deliveries carry no signature. Verifying first would make it
    // impossible to ever register the endpoint.
    const payload = urlValidationPayload();
    const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');

    const result = handleWebhook({ rawBody, headers: {}, secret: TEST_SECRET });

    assert.equal(result.status, 200);
  });

  test('should return a stream_start action for a validly signed meeting.rtms_started', () => {
    const payload = rtmsStartedPayload();
    const { rawBody, headers } = signedDelivery(payload);

    const result = handleWebhook({ rawBody, headers, secret: TEST_SECRET });

    assert.equal(result.status, 200);
    assert.equal(result.action.type, 'stream_start');
    assert.equal(result.action.payload.rtms_stream_id, 'stream-id-111');
    assert.equal(result.action.payload.meeting_uuid, 'meeting-uuid-aaa');
  });

  test('should return a stream_stop action for a validly signed meeting.rtms_stopped', () => {
    const { rawBody, headers } = signedDelivery(rtmsStoppedPayload());

    const result = handleWebhook({ rawBody, headers, secret: TEST_SECRET });

    assert.equal(result.status, 200);
    assert.equal(result.action.type, 'stream_stop');
    assert.equal(result.action.payload.rtms_stream_id, 'stream-id-111');
  });

  test('should return 401 and no action when the signature is invalid', () => {
    const { rawBody, headers } = signedDelivery(rtmsStartedPayload(), { secret: 'attacker_secret' });

    const result = handleWebhook({ rawBody, headers, secret: TEST_SECRET });

    assert.equal(result.status, 401);
    assert.equal(result.action.type, 'ignore');
  });

  test('should return 401 and no action when the timestamp is stale', () => {
    const { rawBody, headers } = signedDelivery(rtmsStartedPayload(), { timestamp: nowSeconds(-600) });

    const result = handleWebhook({ rawBody, headers, secret: TEST_SECRET });

    assert.equal(result.status, 401);
    assert.equal(result.action.type, 'ignore');
  });

  test('should return 401 when signature headers are absent entirely', () => {
    const rawBody = Buffer.from(JSON.stringify(rtmsStartedPayload()), 'utf8');

    const result = handleWebhook({ rawBody, headers: {}, secret: TEST_SECRET });

    assert.equal(result.status, 401);
  });

  test('should ignore a signed event type it does not handle', () => {
    const { rawBody, headers } = signedDelivery({ event: 'meeting.started', payload: {} });

    const result = handleWebhook({ rawBody, headers, secret: TEST_SECRET });

    assert.equal(result.status, 200);
    assert.equal(result.action.type, 'ignore');
  });

  test('should return 401 rather than throwing on an unparseable body', () => {
    const rawBody = Buffer.from('this is not json', 'utf8');
    const timestamp = nowSeconds();

    const result = handleWebhook({
      rawBody,
      headers: {
        'x-zm-request-timestamp': timestamp,
        'x-zm-signature': signBody(rawBody, timestamp),
      },
      secret: TEST_SECRET,
    });

    assert.equal(result.status, 401);
    assert.equal(result.action.type, 'ignore');
  });

  test('should decide in well under the 3 second webhook response budget', () => {
    const { rawBody, headers } = signedDelivery(rtmsStartedPayload());

    const started = process.hrtime.bigint();
    handleWebhook({ rawBody, headers, secret: TEST_SECRET });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.ok(elapsedMs < 50, `expected under 50ms, got ${elapsedMs.toFixed(2)}ms`);
  });
});
