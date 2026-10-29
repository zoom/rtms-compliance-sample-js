/**
 * Fake, not mock.
 *
 * `@zoom/rtms` is a native addon. Loading it in unit tests would require the
 * prebuilt binary for the host platform and would make the tests depend on
 * Zoom infrastructure. Instead the session module accepts a client factory,
 * and tests inject this fake through it. The real addon is exercised by the
 * Docker job in CI, which is the only place that can prove it loads.
 *
 * The fake records every call so tests can assert ordering, which matters:
 * callbacks registered after join() miss early segments.
 */
export function createFakeRtms({ joinResult = true, joinError = null } = {}) {
  const clients = [];

  class FakeClient {
    constructor() {
      this.calls = [];
      this.callbacks = {};
      this.joined = false;
      this.left = false;
      this.joinPayload = null;
      this.transcriptParams = null;
      this.proxy = null;
      this._uuid = null;
      this._streamId = null;
      clients.push(this);
    }

    #record(name, args) {
      this.calls.push({ name, args });
      return true;
    }

    #register(name, callback) {
      this.callbacks[name] = callback;
      return this.#record(name, [callback]);
    }

    setTranscriptParams(params) {
      this.transcriptParams = params;
      return this.#record('setTranscriptParams', [params]);
    }

    setProxy(type, url) {
      this.proxy = { type, url };
      return this.#record('setProxy', [type, url]);
    }

    onTranscriptData(cb) {
      return this.#register('onTranscriptData', cb);
    }
    onParticipantEvent(cb) {
      return this.#register('onParticipantEvent', cb);
    }
    onActiveSpeakerEvent(cb) {
      return this.#register('onActiveSpeakerEvent', cb);
    }
    onJoinConfirm(cb) {
      return this.#register('onJoinConfirm', cb);
    }
    onLeave(cb) {
      return this.#register('onLeave', cb);
    }
    onMediaConnectionInterrupted(cb) {
      return this.#register('onMediaConnectionInterrupted', cb);
    }

    join(payload) {
      this.joined = true;
      this.joinPayload = payload;
      this._uuid = payload?.meeting_uuid ?? null;
      this._streamId = payload?.rtms_stream_id ?? null;
      this.#record('join', [payload]);
      if (joinError) throw joinError;
      return joinResult;
    }

    leave() {
      this.left = true;
      return this.#record('leave', []);
    }

    uuid() {
      return this._uuid;
    }
    streamId() {
      return this._streamId;
    }

    /** Index of a call by name, or -1. Used to assert ordering against join. */
    callIndex(name) {
      return this.calls.findIndex((c) => c.name === name);
    }

    /** Drive a transcript segment as the SDK would: Buffer, size, ms, metadata. */
    emitTranscript(text, { timestamp = 1756200001000, userId = 42, userName = 'Rep Name' } = {}) {
      const buffer = Buffer.from(text, 'utf8');
      this.callbacks.onTranscriptData?.(buffer, buffer.length, timestamp, { userId, userName });
    }

    emitMediaInterrupted(timestamp = 1756200030000) {
      this.callbacks.onMediaConnectionInterrupted?.(timestamp);
    }

    emitJoinConfirm(reason = 0) {
      this.callbacks.onJoinConfirm?.(reason);
    }

    emitLeave(reason = 0) {
      this.callbacks.onLeave?.(reason);
    }

    emitParticipantEvent(
      event = 1,
      timestamp = 1756200002000,
      participants = [{ userId: 42, userName: 'Rep Name' }],
    ) {
      this.callbacks.onParticipantEvent?.(event, timestamp, participants);
    }
  }

  return {
    /** Pass as the clientFactory the session module depends on. */
    factory: () => new FakeClient(),
    /** Every client the factory has produced, in creation order. */
    clients,
    latest: () => clients.at(-1),
    TranscriptLanguage: { ENGLISH: 1, SPANISH: 2, NONE: 0 },
  };
}
