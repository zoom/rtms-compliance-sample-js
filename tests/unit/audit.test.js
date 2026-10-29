import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  GENESIS_HASH,
  canonicalize,
  buildAuditRecord,
  verifyChain,
} from '../../src/compliance/audit.js';

// Acceptance criteria 35-41.

const baseRecord = (overrides = {}) => ({
  id: 'rec-1',
  seqNo: 7,
  ruleId: 'guaranteed-return',
  rulePackVersion: 'fin-us-retail-v4',
  severity: 'high',
  quote: 'we can offer a guaranteed return',
  verdict: 'violation',
  modelId: 'anthropic/claude-sonnet-5',
  occurredAt: 1756200001000,
  ...overrides,
});

function buildChain(meetingId, records) {
  const chain = [];
  let prevHash = GENESIS_HASH;
  for (const record of records) {
    const built = buildAuditRecord(meetingId, prevHash, record);
    chain.push(built);
    prevHash = built.hash;
  }
  return chain;
}

describe('GENESIS_HASH', () => {
  test('should be 64 zero characters', () => {
    assert.equal(GENESIS_HASH, '0'.repeat(64));
    assert.equal(GENESIS_HASH.length, 64);
  });
});

describe('buildAuditRecord', () => {
  test('should set prevHash to the genesis value on the first record', () => {
    const record = buildAuditRecord('meeting-1', GENESIS_HASH, baseRecord());

    assert.equal(record.prevHash, GENESIS_HASH);
  });

  test('should produce a 64 character hex hash', () => {
    const record = buildAuditRecord('meeting-1', GENESIS_HASH, baseRecord());

    assert.match(record.hash, /^[0-9a-f]{64}$/);
  });

  test('should link each record prevHash to the previous record hash', () => {
    const chain = buildChain('meeting-1', [
      baseRecord({ id: 'rec-1', seqNo: 1 }),
      baseRecord({ id: 'rec-2', seqNo: 2 }),
      baseRecord({ id: 'rec-3', seqNo: 3 }),
    ]);

    assert.equal(chain[1].prevHash, chain[0].hash);
    assert.equal(chain[2].prevHash, chain[1].hash);
  });

  test('should produce a different hash when any covered field changes', () => {
    const a = buildAuditRecord('meeting-1', GENESIS_HASH, baseRecord({ severity: 'high' }));
    const b = buildAuditRecord('meeting-1', GENESIS_HASH, baseRecord({ severity: 'medium' }));

    assert.notEqual(a.hash, b.hash);
  });

  test('should produce a different hash for the same content under a different meeting', () => {
    const a = buildAuditRecord('meeting-1', GENESIS_HASH, baseRecord());
    const b = buildAuditRecord('meeting-2', GENESIS_HASH, baseRecord());

    assert.notEqual(a.hash, b.hash);
  });

  test('should preserve the original record fields on the returned object', () => {
    const record = buildAuditRecord('meeting-1', GENESIS_HASH, baseRecord());

    assert.equal(record.ruleId, 'guaranteed-return');
    assert.equal(record.quote, 'we can offer a guaranteed return');
    assert.equal(record.meetingId, 'meeting-1');
  });
});

describe('canonicalize', () => {
  test('should serialize identically regardless of input key order', () => {
    const forward = { meetingId: 'm', seqNo: 1, ruleId: 'r', severity: 'high' };
    const reversed = { severity: 'high', ruleId: 'r', seqNo: 1, meetingId: 'm' };

    assert.equal(canonicalize(forward), canonicalize(reversed));
  });

  test('should hash identically for records built from differently ordered objects', () => {
    const forward = buildAuditRecord('m', GENESIS_HASH, {
      id: 'rec-1',
      seqNo: 1,
      ruleId: 'r',
      rulePackVersion: 'v1',
      severity: 'high',
      quote: 'q',
      verdict: 'violation',
      modelId: 'model',
      occurredAt: 1,
    });
    const reversed = buildAuditRecord('m', GENESIS_HASH, {
      occurredAt: 1,
      modelId: 'model',
      verdict: 'violation',
      quote: 'q',
      severity: 'high',
      rulePackVersion: 'v1',
      ruleId: 'r',
      seqNo: 1,
      id: 'rec-1',
    });

    assert.equal(forward.hash, reversed.hash);
  });
});

describe('verifyChain', () => {
  test('should report a well-formed chain as valid', () => {
    const chain = buildChain('meeting-1', [
      baseRecord({ id: 'rec-1', seqNo: 1 }),
      baseRecord({ id: 'rec-2', seqNo: 2 }),
      baseRecord({ id: 'rec-3', seqNo: 3 }),
    ]);

    assert.deepEqual(verifyChain(chain), { valid: true });
  });

  test('should report an empty chain as valid', () => {
    assert.equal(verifyChain([]).valid, true);
  });

  test('should detect a mutated field and name the first bad record', () => {
    const chain = buildChain('meeting-1', [
      baseRecord({ id: 'rec-1', seqNo: 1 }),
      baseRecord({ id: 'rec-2', seqNo: 2 }),
      baseRecord({ id: 'rec-3', seqNo: 3 }),
    ]);

    chain[1].quote = 'a quote nobody said';

    const result = verifyChain(chain);
    assert.equal(result.valid, false);
    assert.equal(result.firstInvalidId, 'rec-2');
  });

  test('should detect a mutated severity even when the quote is untouched', () => {
    const chain = buildChain('meeting-1', [baseRecord({ id: 'rec-1', seqNo: 1 })]);

    chain[0].severity = 'low';

    assert.equal(verifyChain(chain).valid, false);
  });

  test('should detect a record deleted from the middle of the chain', () => {
    const chain = buildChain('meeting-1', [
      baseRecord({ id: 'rec-1', seqNo: 1 }),
      baseRecord({ id: 'rec-2', seqNo: 2 }),
      baseRecord({ id: 'rec-3', seqNo: 3 }),
    ]);

    const tampered = [chain[0], chain[2]];

    const result = verifyChain(tampered);
    assert.equal(result.valid, false);
    assert.equal(result.firstInvalidId, 'rec-3', 'the orphaned successor is the first bad link');
  });

  test('should detect a record appended with a forged prevHash', () => {
    const chain = buildChain('meeting-1', [baseRecord({ id: 'rec-1', seqNo: 1 })]);
    chain.push({
      ...baseRecord({ id: 'rec-forged', seqNo: 2 }),
      meetingId: 'meeting-1',
      prevHash: GENESIS_HASH,
      hash: 'f'.repeat(64),
    });

    assert.equal(verifyChain(chain).valid, false);
  });

  test('should detect a first record whose prevHash is not the genesis value', () => {
    const chain = buildChain('meeting-1', [baseRecord({ id: 'rec-1', seqNo: 1 })]);
    chain[0].prevHash = 'a'.repeat(64);

    const result = verifyChain(chain);
    assert.equal(result.valid, false);
    assert.equal(result.firstInvalidId, 'rec-1');
  });

  test('should give a reason describing the failure', () => {
    const chain = buildChain('meeting-1', [baseRecord({ id: 'rec-1', seqNo: 1 })]);
    chain[0].quote = 'tampered';

    assert.equal(typeof verifyChain(chain).reason, 'string');
  });
});

describe('corrections', () => {
  test('should record a correction as a new appended record referencing the original', () => {
    const chain = buildChain('meeting-1', [baseRecord({ id: 'rec-1', seqNo: 1 })]);
    const correction = buildAuditRecord('meeting-1', chain[0].hash, {
      ...baseRecord({ id: 'rec-2', seqNo: 1 }),
      verdict: 'not-a-violation',
      correctsId: 'rec-1',
    });
    chain.push(correction);

    assert.equal(verifyChain(chain).valid, true);
    assert.equal(chain[0].verdict, 'violation', 'the original record must be left intact');
    assert.equal(chain[1].correctsId, 'rec-1');
  });
});
