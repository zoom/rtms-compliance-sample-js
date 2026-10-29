-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "topic" TEXT,
    "rulePackVersion" TEXT NOT NULL,
    "representativeId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptSegment" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "seqNo" INTEGER NOT NULL,
    "speakerId" INTEGER,
    "speakerLabel" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "tStartMs" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditRecord" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "seqNo" INTEGER,
    "ruleId" TEXT,
    "rulePackVersion" TEXT NOT NULL,
    "severity" TEXT,
    "quote" TEXT,
    "verdict" TEXT,
    "modelId" TEXT,
    "correctsId" TEXT,
    "occurredAt" BIGINT NOT NULL,
    "prevHash" CHAR(64) NOT NULL,
    "hash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Meeting_startedAt_idx" ON "Meeting"("startedAt");

-- CreateIndex
CREATE INDEX "TranscriptSegment_meetingId_seqNo_idx" ON "TranscriptSegment"("meetingId", "seqNo");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptSegment_meetingId_seqNo_key" ON "TranscriptSegment"("meetingId", "seqNo");

-- CreateIndex
CREATE INDEX "AuditRecord_meetingId_createdAt_idx" ON "AuditRecord"("meetingId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditRecord_hash_idx" ON "AuditRecord"("hash");

-- AddForeignKey
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

