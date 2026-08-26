import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionManager } from '../../src/rtms/session.js';
import { createFakeRtms } from '../helpers/fake-rtms.js';
import { rtmsStartedPayload, rtmsStoppedPayload } from '../helpers/signing.js';

// Acceptance criteria 7-13.

let fake;
let audit;
let alerts;

function manager(overrides = {}) {
  return createSessionManager({
    clientFactory: fake.factory,
    transcriptLanguage: fake.TranscriptLanguage.ENGLISH,
    onAlert: (alert) => alerts.push(alert),
    audit: {
      open: (meetingId, reason) => audit.push({ type: 'open', meetingId, reason }),
      close: (meetingId, reason) => audit.push({ type: 'close', meetingId, reason }),
      coverageGap: (meetingId, timestamp) =>
        audit.push({ type: 'coverage_gap', meetingId, timestamp }),
      attendance: (meetingId, participants) =>
        audit.push({ type: 'attendance', meetingId, participants }),
    },
    ...overrides,
  });
}

beforeEach(() => {
  fake = createFakeRtms();
  audit = [];
  alerts = [];
});

describe('starting a stream', () => {
  test('should register every callback before calling join', () => {
    manager().startStream(rtmsStartedPayload().payload);
    const client = fake.latest();

    const joinIndex = client.callIndex('join');
    for (const callback of [
      'onTranscriptData',
      'onParticipantEvent',
      'onJoinConfirm',
      'onLeave',
      'onMediaConnectionInterrupted',
    ]) {
      const index = client.callIndex(callback);
      assert.notEqual(index, -1, `${callback} was never registered`);
      assert.ok(index < joinIndex, `${callback} must be registered before join()`);
    }
  });

  test('should call setTranscriptParams before join', () => {
    manager().startStream(rtmsStartedPayload().payload);
    const client = fake.latest();

    const paramsIndex = client.callIndex('setTranscriptParams');
    assert.notEqual(paramsIndex, -1, 'setTranscriptParams was never called');
    assert.ok(paramsIndex < client.callIndex('join'));
  });

  test('should set an explicit source language rather than relying on auto-detect', () => {
    // Auto-detect costs roughly 30 seconds. On a regulated call that is 30
    // seconds of unscreened conversation, right where consent language lives.
    manager().startStream(rtmsStartedPayload().payload);

    assert.equal(fake.latest().transcriptParams.srcLanguage, fake.TranscriptLanguage.ENGLISH);
    assert.notEqual(fake.latest().transcriptParams.srcLanguage, fake.TranscriptLanguage.NONE);
  });

  test('should join with the webhook payload', () => {
    const payload = rtmsStartedPayload().payload;

    manager().startStream(payload);

    assert.equal(fake.latest().joined, true);
    assert.equal(fake.latest().joinPayload.rtms_stream_id, 'stream-id-111');
    assert.equal(fake.latest().joinPayload.server_urls, 'wss://rtms.example.zoom.us');
  });

  test('should open the audit chain on join confirmation', () => {
    manager().startStream(rtmsStartedPayload().payload);

    fake.latest().emitJoinConfirm(0);

    assert.deepEqual(
      audit.filter((a) => a.type === 'open').map((a) => a.meetingId),
      ['meeting-uuid-aaa'],
    );
  });

  test('should not register audio, video, or deskshare callbacks', () => {
    // Transcript only. Registering media callbacks would pull PII into the
    // process with nothing consuming it.
    manager().startStream(rtmsStartedPayload().payload);
    const client = fake.latest();

    for (const unwanted of ['onAudioData', 'onVideoData', 'onDeskshareData']) {
      assert.equal(client.callIndex(unwanted), -1, `${unwanted} must not be registered`);
    }
  });
});

describe('duplicate deliveries', () => {
  test('should ignore a second start for a stream id already tracked', () => {
    const m = manager();
    const payload = rtmsStartedPayload().payload;

    m.startStream(payload);
    m.startStream(payload);

    assert.equal(fake.clients.length, 1, 'exactly one client per rtms_stream_id');
  });

  test('should report the tracked stream count', () => {
    const m = manager();

    m.startStream(rtmsStartedPayload().payload);
    m.startStream(rtmsStartedPayload().payload);

    assert.equal(m.activeStreamCount(), 1);
  });
});

describe('stream failover', () => {
  test('should leave the old client when a new stream id arrives for the same meeting', () => {
    const m = manager();

    m.startStream(rtmsStartedPayload().payload);
    const original = fake.latest();

    m.startStream(rtmsStartedPayload({ rtms_stream_id: 'stream-id-222' }).payload);
    const replacement = fake.latest();

    assert.equal(original.left, true, 'the superseded client must be left');
    assert.equal(replacement.joined, true);
    assert.notEqual(original, replacement);
  });

  test('should track only the new stream id after failover', () => {
    const m = manager();

    m.startStream(rtmsStartedPayload().payload);
    m.startStream(rtmsStartedPayload({ rtms_stream_id: 'stream-id-222' }).payload);

    assert.equal(m.activeStreamCount(), 1);
    assert.equal(m.hasStream('stream-id-111'), false);
    assert.equal(m.hasStream('stream-id-222'), true);
  });

  test('should keep separate streams for genuinely different meetings', () => {
    const m = manager();

    m.startStream(rtmsStartedPayload().payload);
    m.startStream(
      rtmsStartedPayload({ meeting_uuid: 'meeting-uuid-bbb', rtms_stream_id: 'stream-id-999' })
        .payload,
    );

    assert.equal(m.activeStreamCount(), 2);
    assert.equal(fake.clients[0].left, false, 'a different meeting must not evict the first');
  });
});

describe('stopping a stream', () => {
  test('should leave the client on meeting.rtms_stopped', () => {
    const m = manager();
    m.startStream(rtmsStartedPayload().payload);

    m.stopStream(rtmsStoppedPayload().payload);

    assert.equal(fake.latest().left, true);
  });

  test('should stop tracking the stream after stop', () => {
    const m = manager();
    m.startStream(rtmsStartedPayload().payload);

    m.stopStream(rtmsStoppedPayload().payload);

    assert.equal(m.activeStreamCount(), 0);
  });

  test('should close the audit chain on stop', () => {
    const m = manager();
    m.startStream(rtmsStartedPayload().payload);

    m.stopStream(rtmsStoppedPayload().payload);

    assert.ok(audit.some((a) => a.type === 'close' && a.meetingId === 'meeting-uuid-aaa'));
  });

  test('should tolerate a stop for a stream it never tracked', () => {
    const m = manager();

    assert.doesNotThrow(() =>
      m.stopStream(rtmsStoppedPayload({ rtms_stream_id: 'unknown' }).payload),
    );
  });

  test('should close the audit chain when onLeave fires without a stop webhook', () => {
    // The stream can end without a webhook: host ends the meeting, media
    // server drops the session. onLeave is the reliable signal.
    const m = manager();
    m.startStream(rtmsStartedPayload().payload);

    fake.latest().emitLeave(1);

    assert.ok(audit.some((a) => a.type === 'close'));
    assert.equal(m.activeStreamCount(), 0);
  });

  test('should not double-close the audit chain when stop follows onLeave', () => {
    const m = manager();
    m.startStream(rtmsStartedPayload().payload);

    fake.latest().emitLeave(1);
    m.stopStream(rtmsStoppedPayload().payload);

    assert.equal(audit.filter((a) => a.type === 'close').length, 1);
  });
});

describe('coverage gaps', () => {
  test('should write a coverage gap when the media connection is interrupted', () => {
    manager().startStream(rtmsStartedPayload().payload);

    fake.latest().emitMediaInterrupted(1756200030000);

    const gap = audit.find((a) => a.type === 'coverage_gap');
    assert.ok(gap, 'an interrupted media connection must be recorded');
    assert.equal(gap.timestamp, 1756200030000);
    assert.equal(gap.meetingId, 'meeting-uuid-aaa');
  });

  test('should record one gap per interruption', () => {
    manager().startStream(rtmsStartedPayload().payload);

    fake.latest().emitMediaInterrupted(1756200030000);
    fake.latest().emitMediaInterrupted(1756200090000);

    assert.equal(audit.filter((a) => a.type === 'coverage_gap').length, 2);
  });
});

describe('attendance', () => {
  test('should record the attendee roster from onParticipantEvent', () => {
    manager().startStream(rtmsStartedPayload().payload);

    fake.latest().emitParticipantEvent(1, 1756200002000, [
      { userId: 42, userName: 'Dana Rep' },
      { userId: 77, userName: 'Client Name' },
    ]);

    const attendance = audit.find((a) => a.type === 'attendance');
    assert.ok(attendance);
    assert.equal(attendance.participants.length, 2);
  });
});

describe('transcript flow', () => {
  test('should assign sequence numbers across segments on one stream', () => {
    const seen = [];
    const m = manager({ onSegment: (segment) => seen.push(segment) });
    m.startStream(rtmsStartedPayload().payload);

    fake.latest().emitTranscript('first phrase');
    fake.latest().emitTranscript('second phrase');

    assert.deepEqual(
      seen.map((s) => s.seqNo),
      [0, 1],
    );
    assert.deepEqual(
      seen.map((s) => s.text),
      ['first phrase', 'second phrase'],
    );
  });

  test('should restart sequence numbering for a new stream after failover', () => {
    const seen = [];
    const m = manager({ onSegment: (segment) => seen.push(segment) });

    m.startStream(rtmsStartedPayload().payload);
    fake.latest().emitTranscript('before failover');

    m.startStream(rtmsStartedPayload({ rtms_stream_id: 'stream-id-222' }).payload);
    fake.latest().emitTranscript('after failover');

    assert.equal(seen[0].seqNo, 0);
    assert.equal(seen[1].seqNo, 0, 'a new stream gets its own counter');
  });
});

describe('proxy configuration', () => {
  test('should call setProxy before join when a proxy url is configured', () => {
    const m = manager({ proxyUrl: 'http://proxy.internal.example.com:3128' });

    m.startStream(rtmsStartedPayload().payload);
    const client = fake.latest();

    assert.deepEqual(client.proxy, { type: 'http', url: 'http://proxy.internal.example.com:3128' });
    assert.ok(client.callIndex('setProxy') < client.callIndex('join'));
  });

  test('should not call setProxy when no proxy url is configured', () => {
    manager().startStream(rtmsStartedPayload().payload);

    assert.equal(fake.latest().callIndex('setProxy'), -1);
  });
});
