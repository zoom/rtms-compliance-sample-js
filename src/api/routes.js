/**
 * Audit export API.
 *
 * The endpoint returns the chain and a verification result together. It
 * deliberately still answers 200 when verification fails: a tampered chain is
 * a finding the caller needs to see, not a server error to retry.
 *
 * Authorization here is meeting-scoped, matching the panel's JWT. That is the
 * right boundary for a sample and the wrong one for production, where auditors
 * need to read chains for meetings they never attended. See the README.
 */
import jwt from 'jsonwebtoken';
import { verifyChain } from '../compliance/audit.js';

function bearerToken(req) {
  const header = req.headers?.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
}

export function createAuditRouter({ store, jwtSecret, logger = console }) {
  return {
    /**
     * GET /api/meetings/:id/audit
     *
     * @param {object} req { params: { id }, headers }
     * @param {object} res express-style { status(code), json(body) }
     */
    async handle(req, res) {
      const token = bearerToken(req);
      if (!token) {
        return res.status(401).json({ error: 'Missing bearer token' });
      }

      let claims;
      try {
        claims = jwt.verify(token, jwtSecret);
      } catch (err) {
        logger.warn?.(`rejected audit request: ${err.message}`);
        return res.status(401).json({ error: 'Invalid token' });
      }

      const meetingId = req.params?.id;
      if (claims.meetingId !== meetingId) {
        // Authenticated, but for a different meeting. 403, not 401: retrying
        // with the same credential will never work.
        return res.status(403).json({ error: 'Token is not scoped to this meeting' });
      }

      const records = await store.listByMeeting(meetingId);

      return res.json({
        meetingId,
        records,
        verification: verifyChain(records),
      });
    },
  };
}
