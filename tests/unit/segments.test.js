import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSegmentNormalizer, SPEAKER_DEFAULTS } from '../../src/rtms/segments.js';

// Acceptance criteria 14-18.

describe('createSegmentNormalizer', () => {
  test('should decode the Buffer the SDK passes into a UTF-8 string', () => {
    const normalize = createSegmentNormalizer();
    const text = 'We can offer a guaranteed return on this fund';
    const buffer = Buffer.from(text, 'utf8');

    const segment = normalize(buffer, buffer.length, 1756200001000, {
      userId: 42,
      userName: 'Rep',
    });

    assert.equal(segment.text, text);
    assert.equal(typeof segment.text, 'string');
  });

  test('should decode multi-byte UTF-8 without corruption', () => {
    const normalize = createSegmentNormalizer();
    const text = 'garantía del 8 % — sin riesgo';
    const buffer = Buffer.from(text, 'utf8');

    const segment = normalize(buffer, buffer.length, 1756200001000, {
      userId: 42,
      userName: 'Rep',
    });

    assert.equal(segment.text, text);
  });

  test('should store the callback timestamp unchanged as Unix milliseconds', () => {
    const normalize = createSegmentNormalizer();
    const buffer = Buffer.from('hello', 'utf8');
    const timestamp = 1756200001000;

    const segment = normalize(buffer, buffer.length, timestamp, { userId: 42, userName: 'Rep' });

    // The SDK documents media callback timestamps as Unix milliseconds.
    // Dividing by 1000 here would be a silent 1000x error.
    assert.equal(segment.tStartMs, timestamp);
  });

  test('should assign sequence numbers starting at 0 and incrementing by 1', () => {
    const normalize = createSegmentNormalizer();
    const emit = (text) => {
      const b = Buffer.from(text, 'utf8');
      return normalize(b, b.length, 1756200001000, { userId: 42, userName: 'Rep' });
    };

    assert.equal(emit('one').seqNo, 0);
    assert.equal(emit('two').seqNo, 1);
    assert.equal(emit('three').seqNo, 2);
  });

  test('should scope sequence numbers per normalizer instance', () => {
    const streamA = createSegmentNormalizer();
    const streamB = createSegmentNormalizer();
    const emit = (fn, text) => {
      const b = Buffer.from(text, 'utf8');
      return fn(b, b.length, 1756200001000, { userId: 1, userName: 'Rep' });
    };

    assert.equal(emit(streamA, 'a1').seqNo, 0);
    assert.equal(emit(streamA, 'a2').seqNo, 1);
    assert.equal(emit(streamB, 'b1').seqNo, 0, 'a second stream starts its own counter');
  });

  test('should carry speaker identity from metadata', () => {
    const normalize = createSegmentNormalizer();
    const buffer = Buffer.from('hello', 'utf8');

    const segment = normalize(buffer, buffer.length, 1756200001000, {
      userId: 99,
      userName: 'Dana Rep',
    });

    assert.equal(segment.speakerId, 99);
    assert.equal(segment.speakerLabel, 'Dana Rep');
  });

  test('should apply documented defaults when userId is missing', () => {
    const normalize = createSegmentNormalizer();
    const buffer = Buffer.from('hello', 'utf8');

    const segment = normalize(buffer, buffer.length, 1756200001000, { userName: 'Dana Rep' });

    assert.equal(segment.speakerId, SPEAKER_DEFAULTS.speakerId);
    assert.equal(segment.speakerLabel, 'Dana Rep');
  });

  test('should apply documented defaults when userName is missing', () => {
    const normalize = createSegmentNormalizer();
    const buffer = Buffer.from('hello', 'utf8');

    const segment = normalize(buffer, buffer.length, 1756200001000, { userId: 99 });

    assert.equal(segment.speakerId, 99);
    assert.equal(segment.speakerLabel, SPEAKER_DEFAULTS.speakerLabel);
  });

  test('should not throw when metadata is absent entirely', () => {
    const normalize = createSegmentNormalizer();
    const buffer = Buffer.from('hello', 'utf8');

    const segment = normalize(buffer, buffer.length, 1756200001000, undefined);

    assert.equal(segment.speakerId, SPEAKER_DEFAULTS.speakerId);
    assert.equal(segment.speakerLabel, SPEAKER_DEFAULTS.speakerLabel);
    assert.equal(segment.text, 'hello');
  });

  test('should expose the fields the persistence layer upserts on', () => {
    const normalize = createSegmentNormalizer();
    const buffer = Buffer.from('hello', 'utf8');

    const segment = normalize(buffer, buffer.length, 1756200001000, { userId: 1, userName: 'Rep' });

    // Upsert key is (meetingId, seqNo); meetingId is attached by the caller,
    // so the normalizer must at minimum supply a stable seqNo.
    for (const field of ['speakerId', 'speakerLabel', 'text', 'tStartMs', 'seqNo']) {
      assert.ok(field in segment, `missing field: ${field}`);
    }
  });
});
