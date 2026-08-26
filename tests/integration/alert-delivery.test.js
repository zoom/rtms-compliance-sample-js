import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { createAlertHub, WS_CLOSE_UNAUTHORIZED } from '../../src/api/ws.js';
import { notifySupervisor } from '../../src/api/supervisor.js';

// Acceptance criteria 43-48.

const JWT_SECRET = 'test-jwt-secret';
const REP_ID = 42;
const CLIENT_ID = 77;
const HOST_ID = 1;

const token = (claims) => jwt.sign(claims, JWT_SECRET, { expiresIn: '1h' });

/** Minimal socket double: records what the hub sent and how it closed. */
function fakeSocket() {
  return {
    sent: [],
    closed: null,
    send(raw) {
      this.sent.push(JSON.parse(raw));
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
    messages() {
      return this.sent;
    },
    typed(type) {
      return this.sent.filter((m) => m.type === type);
    },
  };
}

let hub;

beforeEach(() => {
  hub = createAlertHub({ jwtSecret: JWT_SECRET });
});

const ALERT = {
  ruleId: 'guaranteed-return',
  severity: 'high',
  quote: 'guaranteed return',
  seqNo: 12,
  violation: true,
  confidence: 0.9,
  suggestedLanguage: 'Past performance does not guarantee future results.',
};

describe('WebSocket authentication', () => {
  test('should close a connection with no token', () => {
    const socket = fakeSocket();

    hub.connect(socket, { token: undefined });

    assert.equal(socket.closed.code, WS_CLOSE_UNAUTHORIZED);
  });

  test('should close a connection with a malformed token', () => {
    const socket = fakeSocket();

    hub.connect(socket, { token: 'not.a.jwt' });

    assert.equal(socket.closed.code, WS_CLOSE_UNAUTHORIZED);
  });

  test('should close a connection with a token signed by a different secret', () => {
    const socket = fakeSocket();
    const forged = jwt.sign({ meetingId: 'meeting-1', userId: REP_ID }, 'attacker-secret');

    hub.connect(socket, { token: forged });

    assert.equal(socket.closed.code, WS_CLOSE_UNAUTHORIZED);
  });

  test('should close a connection with an expired token', () => {
    const socket = fakeSocket();
    const expired = jwt.sign({ meetingId: 'meeting-1', userId: REP_ID }, JWT_SECRET, {
      expiresIn: '-1s',
    });

    hub.connect(socket, { token: expired });

    assert.equal(socket.closed.code, WS_CLOSE_UNAUTHORIZED);
  });

  test('should accept a valid token', () => {
    const socket = fakeSocket();

    hub.connect(socket, {
      token: token({ meetingId: 'meeting-1', userId: REP_ID, role: 'representative' }),
    });

    assert.equal(socket.closed, null);
  });

  test('should use close code 4401 for unauthorized', () => {
    assert.equal(WS_CLOSE_UNAUTHORIZED, 4401);
  });
});

describe('subscription scoping', () => {
  test('should reject a subscribe to a meeting the token does not cover', () => {
    const socket = fakeSocket();
    hub.connect(socket, {
      token: token({ meetingId: 'meeting-A', userId: REP_ID, role: 'representative' }),
    });

    hub.handleMessage(socket, { type: 'subscribe', meetingId: 'meeting-B' });

    assert.equal(socket.closed.code, WS_CLOSE_UNAUTHORIZED);
    assert.equal(hub.subscriberCount('meeting-B'), 0);
  });

  test('should accept a subscribe to the meeting the token covers', () => {
    const socket = fakeSocket();
    hub.connect(socket, {
      token: token({ meetingId: 'meeting-A', userId: REP_ID, role: 'representative' }),
    });

    hub.handleMessage(socket, { type: 'subscribe', meetingId: 'meeting-A' });

    assert.equal(hub.subscriberCount('meeting-A'), 1);
  });

  test('should drop a subscription on disconnect', () => {
    const socket = fakeSocket();
    hub.connect(socket, {
      token: token({ meetingId: 'meeting-A', userId: REP_ID, role: 'representative' }),
    });
    hub.handleMessage(socket, { type: 'subscribe', meetingId: 'meeting-A' });

    hub.disconnect(socket);

    assert.equal(hub.subscriberCount('meeting-A'), 0);
  });
});

describe('alert authorization', () => {
  function subscribe(role, userId) {
    const socket = fakeSocket();
    hub.connect(socket, { token: token({ meetingId: 'meeting-A', userId, role }) });
    hub.handleMessage(socket, { type: 'subscribe', meetingId: 'meeting-A' });
    return socket;
  }

  test('should deliver a compliance alert to the assigned representative', () => {
    const rep = subscribe('representative', REP_ID);

    hub.broadcastAlert('meeting-A', ALERT);

    assert.equal(rep.typed('compliance.alert').length, 1);
    assert.equal(rep.typed('compliance.alert')[0].data.ruleId, 'guaranteed-return');
  });

  test('should deliver a compliance alert to the host', () => {
    const host = subscribe('host', HOST_ID);

    hub.broadcastAlert('meeting-A', ALERT);

    assert.equal(host.typed('compliance.alert').length, 1);
  });

  test('should not deliver a compliance alert to a plain participant', () => {
    const participant = subscribe('participant', CLIENT_ID);

    hub.broadcastAlert('meeting-A', ALERT);

    assert.equal(
      participant.typed('compliance.alert').length,
      0,
      'leaking an alert to the client on the call is itself a compliance problem',
    );
  });

  test('should not deliver an alert to a subscriber of a different meeting', () => {
    const other = fakeSocket();
    hub.connect(other, {
      token: token({ meetingId: 'meeting-B', userId: REP_ID, role: 'representative' }),
    });
    hub.handleMessage(other, { type: 'subscribe', meetingId: 'meeting-B' });

    hub.broadcastAlert('meeting-A', ALERT);

    assert.equal(other.typed('compliance.alert').length, 0);
  });

  test('should deliver transcript segments to every subscriber regardless of role', () => {
    const participant = subscribe('participant', CLIENT_ID);

    hub.broadcastSegment('meeting-A', { seqNo: 0, text: 'hello', speakerLabel: 'Rep' });

    assert.equal(participant.typed('transcript.segment').length, 1);
  });
});

describe('reconnect behavior', () => {
  test('should send current alert state before incremental updates resume', () => {
    hub.setMeetingState('meeting-A', {
      alerts: [ALERT],
      disclosures: [
        { id: 'recording-consent', status: 'satisfied', quote: 'this meeting is being recorded' },
      ],
    });

    const rep = fakeSocket();
    hub.connect(rep, {
      token: token({ meetingId: 'meeting-A', userId: REP_ID, role: 'representative' }),
    });
    hub.handleMessage(rep, { type: 'subscribe', meetingId: 'meeting-A' });

    const snapshot = rep.typed('state.snapshot');
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].data.alerts.length, 1);
    assert.equal(snapshot[0].data.disclosures.length, 1);
    assert.equal(rep.messages()[0].type, 'state.snapshot', 'the snapshot must arrive first');
  });

  test('should send an empty snapshot for a meeting with no state yet', () => {
    const rep = fakeSocket();
    hub.connect(rep, {
      token: token({ meetingId: 'meeting-A', userId: REP_ID, role: 'representative' }),
    });
    hub.handleMessage(rep, { type: 'subscribe', meetingId: 'meeting-A' });

    const snapshot = rep.typed('state.snapshot')[0];
    assert.deepEqual(snapshot.data.alerts, []);
  });
});

describe('dismissals', () => {
  test('should write an audit record attributing the dismissal to a user', () => {
    const written = [];
    const localHub = createAlertHub({
      jwtSecret: JWT_SECRET,
      onDismiss: (record) => written.push(record),
    });
    const rep = fakeSocket();
    localHub.connect(rep, {
      token: token({ meetingId: 'meeting-A', userId: REP_ID, role: 'representative' }),
    });
    localHub.handleMessage(rep, { type: 'subscribe', meetingId: 'meeting-A' });

    localHub.handleMessage(rep, {
      type: 'dismiss',
      meetingId: 'meeting-A',
      ruleId: 'guaranteed-return',
      seqNo: 12,
    });

    assert.equal(written.length, 1);
    assert.equal(written[0].dismissedByUserId, REP_ID);
    assert.equal(written[0].ruleId, 'guaranteed-return');
    assert.equal(written[0].seqNo, 12);
  });

  test('should ignore a dismissal from a participant who cannot see alerts', () => {
    const written = [];
    const localHub = createAlertHub({
      jwtSecret: JWT_SECRET,
      onDismiss: (record) => written.push(record),
    });
    const participant = fakeSocket();
    localHub.connect(participant, {
      token: token({ meetingId: 'meeting-A', userId: CLIENT_ID, role: 'participant' }),
    });
    localHub.handleMessage(participant, { type: 'subscribe', meetingId: 'meeting-A' });

    localHub.handleMessage(participant, {
      type: 'dismiss',
      meetingId: 'meeting-A',
      ruleId: 'guaranteed-return',
      seqNo: 12,
    });

    assert.equal(written.length, 0);
  });
});

describe('supervisor escalation', () => {
  test('should POST once for a high-severity alert', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    };

    await notifySupervisor(ALERT, {
      webhookUrl: 'https://supervisor.example.com/hook',
      fetchImpl,
      meetingId: 'meeting-A',
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://supervisor.example.com/hook');
    assert.equal(calls[0].options.method, 'POST');
  });

  test('should include the rule id, severity, and meeting in the payload', async () => {
    let body;
    const fetchImpl = async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200 };
    };

    await notifySupervisor(ALERT, {
      webhookUrl: 'https://supervisor.example.com/hook',
      fetchImpl,
      meetingId: 'meeting-A',
    });

    assert.equal(body.ruleId, 'guaranteed-return');
    assert.equal(body.severity, 'high');
    assert.equal(body.meetingId, 'meeting-A');
  });

  test('should be a no-op when no webhook url is configured', async () => {
    const calls = [];
    const fetchImpl = async () => {
      calls.push(1);
      return { ok: true, status: 200 };
    };

    await notifySupervisor(ALERT, { webhookUrl: undefined, fetchImpl, meetingId: 'meeting-A' });

    assert.equal(calls.length, 0);
  });

  test('should not POST for a medium-severity alert', async () => {
    const calls = [];
    const fetchImpl = async () => {
      calls.push(1);
      return { ok: true, status: 200 };
    };

    await notifySupervisor(
      { ...ALERT, severity: 'medium' },
      { webhookUrl: 'https://supervisor.example.com/hook', fetchImpl, meetingId: 'meeting-A' },
    );

    assert.equal(calls.length, 0);
  });

  test('should not throw when the supervisor endpoint fails', async () => {
    const fetchImpl = async () => {
      throw new Error('connection refused');
    };

    await assert.doesNotReject(() =>
      notifySupervisor(ALERT, {
        webhookUrl: 'https://supervisor.example.com/hook',
        fetchImpl,
        meetingId: 'meeting-A',
      }),
    );
  });
});
