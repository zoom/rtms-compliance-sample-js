import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { createAuditRouter } from '../../src/api/routes.js';
import { GENESIS_HASH, buildAuditRecord } from '../../src/compliance/audit.js';

// Acceptance criterion 42, plus append-only enforcement (41).

const JWT_SECRET = 'test-jwt-secret';
const MEETING = 'meeting-uuid-aaa';

/** In-memory audit store standing in for the Prisma-backed one. */
function memoryStore() {
  const rows = [];
  return {
    rows,
    async append(record) {
      rows.push(record);
      return record;
    },
    async listByMeeting(meetingId) {
      return rows.filter((r) => r.meetingId === meetingId);
    },
    async update() {
      throw new Error('audit records are append-only');
    },
  };
}

function seed(store, count = 3) {
  let prevHash = GENESIS_HASH;
  for (let i = 1; i <= count; i += 1) {
    const record = buildAuditRecord(MEETING, prevHash, {
      id: `rec-${i}`,
      seqNo: i,
      ruleId: 'guaranteed-return',
      rulePackVersion: 'fin-us-retail-v3',
      severity: 'high',
      quote: 'guaranteed return',
      verdict: 'violation',
      modelId: 'anthropic/claude-sonnet-5',
      occurredAt: 1756200000000 + i * 1000,
    });
    store.rows.push(record);
    prevHash = record.hash;
  }
}

/** Drive the router without booting a real HTTP server. */
async function call(router, { method = 'GET', path, token }) {
  const req = {
    method,
    url: path,
    params: { id: path.split('/')[3] },
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  await router.handle(req, res);
  return res;
}

let store;
let router;
const validToken = () => jwt.sign({ meetingId: MEETING, userId: 42, role: 'representative' }, JWT_SECRET);

beforeEach(() => {
  store = memoryStore();
  router = createAuditRouter({ store, jwtSecret: JWT_SECRET });
});

describe('GET /api/meetings/:id/audit', () => {
  test('should return the chain for the meeting', async () => {
    seed(store, 3);

    const res = await call(router, { path: `/api/meetings/${MEETING}/audit`, token: validToken() });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.records.length, 3);
  });

  test('should return a verification result alongside the chain', async () => {
    seed(store, 3);

    const res = await call(router, { path: `/api/meetings/${MEETING}/audit`, token: validToken() });

    assert.deepEqual(res.body.verification, { valid: true });
  });

  test('should report verification failure when a record has been tampered with', async () => {
    seed(store, 3);
    store.rows[1].quote = 'a quote nobody said';

    const res = await call(router, { path: `/api/meetings/${MEETING}/audit`, token: validToken() });

    assert.equal(res.statusCode, 200, 'the endpoint still answers; the chain reports itself invalid');
    assert.equal(res.body.verification.valid, false);
    assert.equal(res.body.verification.firstInvalidId, 'rec-2');
  });

  test('should return an empty chain and a valid verification for an unknown meeting', async () => {
    // The token must be scoped to the meeting being requested. Reading another
    // meeting's chain is a 403, asserted below; an empty chain is not an
    // exception to that rule, so this token is scoped to the unknown meeting.
    const scopedToken = jwt.sign(
      { meetingId: 'no-such-meeting', userId: 42, role: 'representative' },
      JWT_SECRET,
    );

    const res = await call(router, { path: '/api/meetings/no-such-meeting/audit', token: scopedToken });

    assert.equal(res.statusCode, 200, 'an empty chain is a valid answer, not an error');
    assert.deepEqual(res.body.records, []);
    assert.equal(res.body.verification.valid, true);
  });

  test('should reject a request with no token', async () => {
    seed(store, 1);

    const res = await call(router, { path: `/api/meetings/${MEETING}/audit` });

    assert.equal(res.statusCode, 401);
  });

  test('should reject a token scoped to a different meeting', async () => {
    seed(store, 1);
    const otherToken = jwt.sign({ meetingId: 'meeting-uuid-bbb', userId: 42, role: 'representative' }, JWT_SECRET);

    const res = await call(router, { path: `/api/meetings/${MEETING}/audit`, token: otherToken });

    assert.equal(res.statusCode, 403);
  });

  test('should return records in chain order', async () => {
    seed(store, 3);

    const res = await call(router, { path: `/api/meetings/${MEETING}/audit`, token: validToken() });

    assert.deepEqual(
      res.body.records.map((r) => r.id),
      ['rec-1', 'rec-2', 'rec-3'],
    );
  });

  test('should expose both the deterministic ruleId and the model verdict', async () => {
    seed(store, 1);

    const res = await call(router, { path: `/api/meetings/${MEETING}/audit`, token: validToken() });
    const [record] = res.body.records;

    // A reviewer must be able to tell which half was a pattern match and
    // which half was a model judgment.
    assert.equal(record.ruleId, 'guaranteed-return');
    assert.equal(record.verdict, 'violation');
    assert.equal(record.modelId, 'anthropic/claude-sonnet-5');
    assert.equal(record.rulePackVersion, 'fin-us-retail-v3');
  });
});

describe('append-only enforcement', () => {
  test('should reject an attempt to update an existing audit record', async () => {
    seed(store, 1);

    await assert.rejects(() => store.update(store.rows[0].id, { quote: 'changed' }));
  });

  test('should keep the original record intact when a correction is appended', async () => {
    seed(store, 1);
    const original = store.rows[0];

    const correction = buildAuditRecord(MEETING, original.hash, {
      id: 'rec-correction',
      seqNo: 1,
      ruleId: 'guaranteed-return',
      rulePackVersion: 'fin-us-retail-v3',
      severity: 'high',
      quote: 'guaranteed return',
      verdict: 'not-a-violation',
      modelId: 'anthropic/claude-sonnet-5',
      occurredAt: 1756200005000,
      correctsId: 'rec-1',
    });
    await store.append(correction);

    const res = await call(router, { path: `/api/meetings/${MEETING}/audit`, token: validToken() });

    assert.equal(res.body.records.length, 2);
    assert.equal(res.body.records[0].verdict, 'violation');
    assert.equal(res.body.records[1].correctsId, 'rec-1');
    assert.equal(res.body.verification.valid, true);
  });
});
