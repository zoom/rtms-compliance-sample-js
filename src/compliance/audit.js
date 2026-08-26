/**
 * Tamper-evident audit records.
 *
 * Storing evidence of supervision is not the same as being able to prove it
 * was not edited afterward. Each record's hash covers its own content plus the
 * previous record's hash, so any mutation, deletion, or reordering breaks
 * verification from that point forward.
 *
 * This is a hash chain, not a blockchain and not a replacement for immutable
 * storage. It detects tampering; it does not prevent it. See PRODUCTION notes
 * in the README about WORM storage and anchoring chain heads externally.
 */
import crypto from 'node:crypto';

/** prevHash of the first record in a meeting's chain. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Fields covered by the hash. Anything outside this list is metadata that can
 * be added later without invalidating existing records; anything inside it is
 * frozen at write time.
 */
const HASHED_FIELDS = [
  'meetingId',
  'seqNo',
  'ruleId',
  'rulePackVersion',
  'severity',
  'quote',
  'verdict',
  'modelId',
  'occurredAt',
  'correctsId',
  'prevHash',
];

/**
 * Deterministic serialization.
 *
 * Key order in a JavaScript object depends on insertion order, so two records
 * with identical values can serialize differently. Sorting the keys removes
 * that as a source of false verification failures years later, when the
 * writing code has been refactored and no longer builds objects in the same
 * order.
 */
export function canonicalize(record) {
  const projected = {};
  for (const field of HASHED_FIELDS) {
    if (record?.[field] !== undefined) projected[field] = record[field];
  }

  const sorted = Object.keys(projected).sort();
  return JSON.stringify(projected, sorted);
}

function hashOf(record) {
  return crypto.createHash('sha256').update(canonicalize(record)).digest('hex');
}

/**
 * Build the next record in a meeting's chain.
 *
 * @param {string} meetingId
 * @param {string} prevHash hash of the previous record, or GENESIS_HASH
 * @param {object} record alert, disclosure change, coverage gap, or dismissal
 * @returns {object} the record with meetingId, prevHash, and hash attached
 */
export function buildAuditRecord(meetingId, prevHash, record) {
  const linked = { ...record, meetingId, prevHash };
  return { ...linked, hash: hashOf(linked) };
}

/**
 * Replay a chain and confirm every link.
 *
 * @param {Array<object>} records in insertion order
 * @returns {{valid: true} | {valid: false, firstInvalidId: string|undefined, reason: string}}
 */
export function verifyChain(records) {
  let expectedPrevHash = GENESIS_HASH;

  for (const record of records) {
    if (record.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        firstInvalidId: record.id,
        reason: `prevHash mismatch: expected ${expectedPrevHash}, found ${record.prevHash}. A record was deleted, reordered, or inserted.`,
      };
    }

    const recomputed = hashOf(record);
    if (recomputed !== record.hash) {
      return {
        valid: false,
        firstInvalidId: record.id,
        reason: `content hash mismatch: expected ${record.hash}, recomputed ${recomputed}. A covered field was modified after write.`,
      };
    }

    expectedPrevHash = record.hash;
  }

  return { valid: true };
}

/**
 * Create an append-only chain writer over a store.
 *
 * The store must expose `append(record)` and `listByMeeting(meetingId)`. It
 * must not expose an update path for audit rows; a correction is a new record
 * carrying `correctsId`.
 */
export function createAuditChain(store) {
  // meetingId -> hash of the last record we wrote. Rebuilt from the store on
  // a miss, so a process restart mid-meeting does not fork the chain.
  const heads = new Map();

  async function headFor(meetingId) {
    if (heads.has(meetingId)) return heads.get(meetingId);

    const existing = await store.listByMeeting(meetingId);
    const head = existing.length > 0 ? existing[existing.length - 1].hash : GENESIS_HASH;
    heads.set(meetingId, head);
    return head;
  }

  return {
    async append(meetingId, record) {
      const prevHash = await headFor(meetingId);
      const built = buildAuditRecord(meetingId, prevHash, record);
      await store.append(built);
      heads.set(meetingId, built.hash);
      return built;
    },

    async verify(meetingId) {
      return verifyChain(await store.listByMeeting(meetingId));
    },

    /** Drop cached head state once a meeting's chain is closed. */
    forget(meetingId) {
      heads.delete(meetingId);
    },
  };
}
