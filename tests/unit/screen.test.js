import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createScreener } from '../../src/compliance/screen.js';
import { loadPack } from '../../src/compliance/packs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PACK = path.join(HERE, '..', 'fixtures', 'packs', 'valid-pack.yaml');
const SHIPPED_PACK = path.join(HERE, '..', '..', 'rule-packs', 'fin-us-retail-v4.yaml');

const T0 = 1756200000000;
const segment = (text, { seqNo = 0, speakerId = 42 } = {}) => ({
  text,
  seqNo,
  speakerId,
  speakerLabel: 'Rep',
  tStartMs: T0,
});

// Acceptance criteria 21-24.

describe('createScreener', () => {
  test('should produce one candidate for a segment matching one rule', () => {
    const screener = createScreener(loadPack(FIXTURE_PACK), { suppressionWindowSeconds: 60 });

    const candidates = screener.screen(segment('we can offer a guaranteed return here'), T0);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].ruleId, 'guaranteed-return');
    assert.equal(candidates[0].severity, 'high');
    assert.equal(candidates[0].seqNo, 0);
  });

  test('should capture the matched text on the candidate', () => {
    const screener = createScreener(loadPack(FIXTURE_PACK), { suppressionWindowSeconds: 60 });

    const [candidate] = screener.screen(segment('we can offer a guaranteed return here'), T0);

    assert.equal(candidate.matchedText, 'guaranteed return');
  });

  test('should produce two candidates for a segment matching two rules', () => {
    const screener = createScreener(loadPack(FIXTURE_PACK), { suppressionWindowSeconds: 60 });

    const candidates = screener.screen(
      segment('we always beat the market with a guaranteed return'),
      T0,
    );

    assert.equal(candidates.length, 2, 'must not stop at the first match');
    assert.deepEqual(candidates.map((c) => c.ruleId).sort(), [
      'guaranteed-return',
      'unapproved-projection',
    ]);
  });

  test('should produce zero candidates for a clean segment', () => {
    const screener = createScreener(loadPack(FIXTURE_PACK), { suppressionWindowSeconds: 60 });

    assert.deepEqual(screener.screen(segment('thanks for making time today'), T0), []);
  });

  test('should match case-insensitively', () => {
    const screener = createScreener(loadPack(FIXTURE_PACK), { suppressionWindowSeconds: 60 });

    assert.equal(screener.screen(segment('a GUARANTEED RETURN, truly'), T0).length, 1);
  });

  test('should collapse runs of whitespace before matching', () => {
    const screener = createScreener(loadPack(FIXTURE_PACK), { suppressionWindowSeconds: 60 });

    assert.equal(screener.screen(segment('a guaranteed    return'), T0).length, 1);
  });

  test('should not strip punctuation that changes meaning', () => {
    const screener = createScreener(loadPack(FIXTURE_PACK), { suppressionWindowSeconds: 60 });

    // "risk[- ]free" must not be satisfied by "risk. free" across a sentence
    // boundary; that is two different statements.
    assert.deepEqual(screener.screen(segment('there is risk. free consultation though'), T0), []);
  });

  test('should suppress a repeat of the same rule inside the 60 second window', () => {
    const screener = createScreener(loadPack(FIXTURE_PACK), { suppressionWindowSeconds: 60 });

    const first = screener.screen(segment('a guaranteed return', { seqNo: 0 }), T0);
    const repeat = screener.screen(
      segment('again, a guaranteed return', { seqNo: 1 }),
      T0 + 59_000,
    );

    assert.equal(first.length, 1);
    assert.deepEqual(repeat, []);
  });

  test('should emit again once the suppression window has elapsed', () => {
    const screener = createScreener(loadPack(FIXTURE_PACK), { suppressionWindowSeconds: 60 });

    screener.screen(segment('a guaranteed return', { seqNo: 0 }), T0);
    const later = screener.screen(segment('a guaranteed return', { seqNo: 1 }), T0 + 61_000);

    assert.equal(later.length, 1);
  });

  test('should suppress per rule, not globally', () => {
    const screener = createScreener(loadPack(FIXTURE_PACK), { suppressionWindowSeconds: 60 });

    screener.screen(segment('a guaranteed return', { seqNo: 0 }), T0);
    const other = screener.screen(segment('we always beat the index', { seqNo: 1 }), T0 + 1_000);

    assert.equal(other.length, 1, 'a different rule must not be suppressed');
    assert.equal(other[0].ruleId, 'unapproved-projection');
  });

  test('should treat the window boundary at exactly 60 seconds as still suppressed', () => {
    const screener = createScreener(loadPack(FIXTURE_PACK), { suppressionWindowSeconds: 60 });

    screener.screen(segment('a guaranteed return', { seqNo: 0 }), T0);

    assert.deepEqual(
      screener.screen(segment('a guaranteed return', { seqNo: 1 }), T0 + 60_000),
      [],
    );
  });
});

describe('screening latency', () => {
  test('should screen a 200 character segment against the shipped pack in under 5ms', () => {
    const screener = createScreener(loadPack(SHIPPED_PACK), { suppressionWindowSeconds: 60 });
    const text =
      'thank you for your time today, let me walk through the allocation and the fee schedule before we talk about performance over the last decade and what that means for your particular situation'.slice(
        0,
        200,
      );
    const input = segment(text);

    // Warm up so the measurement is not dominated by first-call JIT.
    for (let i = 0; i < 50; i += 1) screener.screen(input, T0);

    const started = process.hrtime.bigint();
    screener.screen(input, T0);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.ok(elapsedMs < 5, `expected under 5ms, got ${elapsedMs.toFixed(3)}ms`);
  });

  test('should perform no regex compilation during screening', () => {
    const pack = loadPack(FIXTURE_PACK);
    const before = pack.prohibited.flatMap((r) => r.patterns);
    const screener = createScreener(pack, { suppressionWindowSeconds: 60 });

    screener.screen(segment('a guaranteed return'), T0);

    const after = pack.prohibited.flatMap((r) => r.patterns);
    assert.deepEqual(
      after.map((p) => p.source),
      before.map((p) => p.source),
    );
    after.forEach((pattern, i) => {
      assert.equal(pattern, before[i], 'screening must reuse the compiled RegExp instances');
    });
  });
});

describe('fin-us-retail-v4 coverage', () => {
  const V4 = path.join(HERE, '..', '..', 'rule-packs', 'fin-us-retail-v4.yaml');
  const flagged = (text) =>
    createScreener(loadPack(V4))
      .screen(segment(text), T0)
      .map((c) => c.ruleId);

  test('should flag a guarantee phrased around a figure', () => {
    assert.deepEqual(flagged('I can guarantee a 1000% return with no risk.'), [
      'guaranteed-return',
    ]);
  });

  test('should flag a request for a social security number', () => {
    assert.deepEqual(flagged('Please send me your social security number.'), [
      'sensitive-data-request',
    ]);
  });

  test('should not flag compliant risk language', () => {
    for (const text of [
      'Investments are not without risk.',
      'Past performance does not guarantee future results.',
      'What is your risk tolerance?',
    ]) {
      assert.deepEqual(flagged(text), [], text);
    }
  });
});
