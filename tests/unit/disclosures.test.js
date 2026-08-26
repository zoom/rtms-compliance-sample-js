import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDisclosureTracker, DISCLOSURE_STATE } from '../../src/compliance/disclosures.js';
import { loadPack } from '../../src/compliance/packs.js';

const FIXTURE_PACK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'packs',
  'valid-pack.yaml',
);

const REP_ID = 42;
const CLIENT_ID = 77;

const segment = (text, { speakerId = REP_ID, seqNo = 0 } = {}) => ({
  text,
  seqNo,
  speakerId,
  speakerLabel: speakerId === REP_ID ? 'Rep' : 'Client',
  tStartMs: 1756200000000 + seqNo * 1000,
});

const tracker = () =>
  createDisclosureTracker(loadPack(FIXTURE_PACK), { representativeUserId: REP_ID });

// Acceptance criteria 31-34.

describe('createDisclosureTracker', () => {
  test('should start every disclosure in the pending state', () => {
    const state = tracker().state();

    assert.equal(state.length, 2);
    for (const disclosure of state) {
      assert.equal(disclosure.status, DISCLOSURE_STATE.PENDING);
    }
  });

  test('should mark a disclosure satisfied when the representative says it', () => {
    const t = tracker();

    t.evaluate([segment('just so you know, this meeting is being recorded', { seqNo: 3 })]);

    const consent = t.state().find((d) => d.id === 'recording-consent');
    assert.equal(consent.status, DISCLOSURE_STATE.SATISFIED);
  });

  test('should store the quote that satisfied the disclosure', () => {
    const t = tracker();
    const text = 'just so you know, this meeting is being recorded';

    t.evaluate([segment(text, { seqNo: 3 })]);

    const consent = t.state().find((d) => d.id === 'recording-consent');
    assert.equal(consent.quote, text);
  });

  test('should store the seqNo of the satisfying segment', () => {
    const t = tracker();

    t.evaluate([segment('this meeting is being recorded', { seqNo: 9 })]);

    assert.equal(t.state().find((d) => d.id === 'recording-consent').seqNo, 9);
  });

  test('should not satisfy a disclosure from a non-representative speaker', () => {
    const t = tracker();

    t.evaluate([segment('this meeting is being recorded', { speakerId: CLIENT_ID, seqNo: 3 })]);

    assert.equal(
      t.state().find((d) => d.id === 'recording-consent').status,
      DISCLOSURE_STATE.PENDING,
      'the client reciting a disclosure does not discharge the representative of it',
    );
  });

  test('should satisfy a disclosure on any of its satisfied_by phrases', () => {
    const t = tracker();

    t.evaluate([segment('let me cover our advisory fee first', { seqNo: 1 })]);

    assert.equal(
      t.state().find((d) => d.id === 'fees-and-conflicts').status,
      DISCLOSURE_STATE.SATISFIED,
    );
  });

  test('should leave other disclosures pending when one is satisfied', () => {
    const t = tracker();

    t.evaluate([segment('this meeting is being recorded', { seqNo: 1 })]);

    assert.equal(
      t.state().find((d) => d.id === 'fees-and-conflicts').status,
      DISCLOSURE_STATE.PENDING,
    );
  });

  test('should never move a satisfied disclosure back to pending', () => {
    const t = tracker();

    t.evaluate([segment('this meeting is being recorded', { seqNo: 1 })]);
    t.evaluate([segment('actually, disregard what I said about recording', { seqNo: 2 })]);

    assert.equal(
      t.state().find((d) => d.id === 'recording-consent').status,
      DISCLOSURE_STATE.SATISFIED,
    );
  });

  test('should keep the original satisfying quote across later evaluations', () => {
    const t = tracker();
    const original = 'this meeting is being recorded';

    t.evaluate([segment(original, { seqNo: 1 })]);
    t.evaluate([segment('this meeting is being recorded, again', { seqNo: 5 })]);

    assert.equal(t.state().find((d) => d.id === 'recording-consent').quote, original);
    assert.equal(t.state().find((d) => d.id === 'recording-consent').seqNo, 1);
  });

  test('should emit a state change only on the transition, not on every evaluation', () => {
    const t = tracker();

    const first = t.evaluate([segment('this meeting is being recorded', { seqNo: 1 })]);
    const second = t.evaluate([segment('this meeting is being recorded', { seqNo: 2 })]);

    assert.equal(first.length, 1);
    assert.equal(first[0].id, 'recording-consent');
    assert.deepEqual(second, [], 'no transition means no state change to broadcast');
  });

  test('should emit one change per disclosure satisfied in the same evaluation', () => {
    const t = tracker();

    const changes = t.evaluate([
      segment('this meeting is being recorded', { seqNo: 1 }),
      segment('and here is our advisory fee', { seqNo: 2 }),
    ]);

    assert.equal(changes.length, 2);
  });

  test('should match case-insensitively', () => {
    const t = tracker();

    t.evaluate([segment('THIS MEETING IS BEING RECORDED', { seqNo: 1 })]);

    assert.equal(
      t.state().find((d) => d.id === 'recording-consent').status,
      DISCLOSURE_STATE.SATISFIED,
    );
  });

  test('should report pending high-severity disclosures for the panel', () => {
    const t = tracker();

    t.evaluate([segment('this meeting is being recorded', { seqNo: 1 })]);

    const pendingHigh = t
      .state()
      .filter((d) => d.status === DISCLOSURE_STATE.PENDING && d.severity === 'high');
    assert.deepEqual(
      pendingHigh.map((d) => d.id),
      ['fees-and-conflicts'],
    );
  });
});
