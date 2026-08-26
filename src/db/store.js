/**
 * Persistence.
 *
 * Two stores with deliberately different shapes:
 *
 * - Transcripts upsert on (meetingId, seqNo), so a replayed segment is
 *   idempotent rather than duplicated.
 * - Audit records only append. There is no update method, and the one in
 *   Prisma is not exposed here. A correction is a new row carrying correctsId.
 */

export function createTranscriptStore(prisma, logger = console) {
  return {
    async ensureMeeting({ meetingId, topic, rulePackVersion, representativeId }) {
      return prisma.meeting.upsert({
        where: { id: meetingId },
        create: { id: meetingId, topic, rulePackVersion, representativeId },
        update: { topic, representativeId },
      });
    },

    async endMeeting(meetingId) {
      return prisma.meeting
        .update({ where: { id: meetingId }, data: { endedAt: new Date() } })
        .catch((err) => logger.warn?.(`could not mark meeting ${meetingId} ended: ${err.message}`));
    },

    /**
     * Persist a segment without blocking the screening path. Callers should
     * not await this: a slow database must not delay an alert.
     */
    async saveSegment(meetingId, segment) {
      return prisma.transcriptSegment.upsert({
        where: { meetingId_seqNo: { meetingId, seqNo: segment.seqNo } },
        create: {
          meetingId,
          seqNo: segment.seqNo,
          speakerId: segment.speakerId,
          speakerLabel: segment.speakerLabel,
          text: segment.text,
          tStartMs: BigInt(segment.tStartMs),
        },
        update: { text: segment.text },
      });
    },

    async listSegments(meetingId) {
      return prisma.transcriptSegment.findMany({
        where: { meetingId },
        orderBy: { seqNo: 'asc' },
      });
    },
  };
}

/** Append-only audit store. Matches the interface createAuditChain expects. */
export function createAuditStore(prisma) {
  const serialize = (record) => ({
    ...record,
    occurredAt: BigInt(record.occurredAt ?? Date.now()),
  });

  const deserialize = (row) => ({ ...row, occurredAt: Number(row.occurredAt) });

  return {
    async append(record) {
      const created = await prisma.auditRecord.create({ data: serialize(record) });
      return deserialize(created);
    },

    /** Chain order is insertion order. Never re-sort by a mutable field. */
    async listByMeeting(meetingId) {
      const rows = await prisma.auditRecord.findMany({
        where: { meetingId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(deserialize);
    },
  };
}
