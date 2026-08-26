/**
 * Alert fan-out to the in-meeting panel.
 *
 * The authorization rule in this file is a compliance requirement, not a UX
 * preference: a compliance alert must reach the representative and the host and
 * nobody else. Rendering "you just promised a guaranteed return" to the client
 * on the other side of the call is a worse outcome than missing the alert.
 *
 * Transport-agnostic on purpose. `connect`/`handleMessage`/`disconnect` take a
 * socket-like object with `send` and `close`, so the whole authorization
 * surface is testable without standing up a server.
 */
import jwt from 'jsonwebtoken';

/** Application close code for an unauthorized socket. 4000-4999 is app-defined. */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/** Roles permitted to receive compliance alerts. */
const ALERT_ROLES = new Set(['representative', 'host']);

const EMPTY_STATE = { alerts: [], disclosures: [] };

export function createAlertHub({ jwtSecret, onDismiss, logger = console }) {
  /** socket -> { claims } */
  const sockets = new Map();
  /** meetingId -> Set<socket> */
  const subscribers = new Map();
  /** meetingId -> { alerts, disclosures } for reconnect snapshots */
  const meetingState = new Map();

  const send = (socket, type, data) => socket.send(JSON.stringify({ type, data }));

  function reject(socket, reason) {
    logger.warn?.(`rejecting websocket: ${reason}`);
    socket.close(WS_CLOSE_UNAUTHORIZED, reason);
    sockets.delete(socket);
  }

  function canSeeAlerts(claims) {
    return ALERT_ROLES.has(claims?.role);
  }

  return {
    /** Authenticate a new socket. Sends nothing on success. */
    connect(socket, { token } = {}) {
      if (!token) return reject(socket, 'missing token');

      let claims;
      try {
        claims = jwt.verify(token, jwtSecret);
      } catch (err) {
        return reject(socket, `invalid token: ${err.message}`);
      }

      if (!claims.meetingId) return reject(socket, 'token carries no meetingId');

      sockets.set(socket, { claims });
      return claims;
    },

    handleMessage(socket, message) {
      const context = sockets.get(socket);
      if (!context) return reject(socket, 'message from an unauthenticated socket');

      const { claims } = context;

      switch (message?.type) {
        case 'subscribe': {
          // A token is scoped to one meeting. Without this check, any valid
          // token would read any meeting's compliance stream.
          if (message.meetingId !== claims.meetingId) {
            return reject(socket, 'token is not scoped to the requested meeting');
          }

          if (!subscribers.has(message.meetingId)) subscribers.set(message.meetingId, new Set());
          subscribers.get(message.meetingId).add(socket);

          // Snapshot first, then incremental updates. A reconnecting panel
          // must not show an empty checklist on a meeting already in progress.
          const state = meetingState.get(message.meetingId) ?? EMPTY_STATE;
          send(socket, 'state.snapshot', {
            alerts: canSeeAlerts(claims) ? state.alerts : [],
            disclosures: state.disclosures,
          });
          return undefined;
        }

        case 'dismiss': {
          if (!canSeeAlerts(claims)) {
            logger.warn?.(`ignoring dismiss from role ${claims.role}`);
            return undefined;
          }

          onDismiss?.({
            meetingId: claims.meetingId,
            ruleId: message.ruleId,
            seqNo: message.seqNo,
            dismissedByUserId: claims.userId,
            occurredAt: Date.now(),
          });
          return undefined;
        }

        default:
          logger.warn?.(`ignoring unknown message type: ${message?.type}`);
          return undefined;
      }
    },

    disconnect(socket) {
      sockets.delete(socket);
      for (const set of subscribers.values()) set.delete(socket);
    },

    /** Compliance alerts: representative and host only. */
    broadcastAlert(meetingId, alert) {
      for (const socket of subscribers.get(meetingId) ?? []) {
        if (!canSeeAlerts(sockets.get(socket)?.claims)) continue;
        send(socket, 'compliance.alert', alert);
      }
    },

    /** Transcript is visible to everyone already; no role filter needed. */
    broadcastSegment(meetingId, segment) {
      for (const socket of subscribers.get(meetingId) ?? []) {
        send(socket, 'transcript.segment', segment);
      }
    },

    broadcastDisclosureState(meetingId, disclosures) {
      for (const socket of subscribers.get(meetingId) ?? []) {
        send(socket, 'disclosure.state', disclosures);
      }
    },

    setMeetingState(meetingId, state) {
      meetingState.set(meetingId, { ...EMPTY_STATE, ...state });
    },

    subscriberCount: (meetingId) => (subscribers.get(meetingId)?.size ?? 0),

    /** Drop retained state once a meeting's chain is closed. */
    forget(meetingId) {
      meetingState.delete(meetingId);
      subscribers.delete(meetingId);
    },
  };
}
