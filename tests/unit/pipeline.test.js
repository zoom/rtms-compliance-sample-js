import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPipeline } from '../../src/compliance/pipeline.js';
import { loadPack } from '../../src/compliance/packs.js';

const shipped = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'rule-packs',
);

/** Records what the pipeline sends to the panel. */
function fakeHub() {
  return {
    states: [],
    disclosureBroadcasts: [],
    setMeetingState(meetingId, state) {
      this.states.push({ meetingId, state });
    },
    broadcastDisclosureState(meetingId, disclosures) {
      this.disclosureBroadcasts.push({ meetingId, disclosures });
    },
    broadcastAlert() {},
    broadcastSegment() {},
  };
}

describe('pipeline startup', () => {
  test('should publish the full disclosure checklist before any segment arrives', () => {
    const hub = fakeHub();
    const pack = loadPack(path.join(shipped, 'fin-us-retail-v4.yaml'));

    const pipeline = createPipeline({
      meetingId: 'meeting-A',
      pack,
      config: { ruleSuppressionWindowSeconds: 60 },
      llm: null,
      hub,
      auditChain: { append: async () => {} },
      logger: { error: () => {} },
    });
    pipeline.stop();

    assert.equal(hub.disclosureBroadcasts.length, 1, 'subscribed panels get the checklist now');
    assert.equal(hub.disclosureBroadcasts[0].disclosures.length, pack.requiredDisclosures.length);
    assert.equal(
      hub.states.at(-1).state.disclosures.length,
      pack.requiredDisclosures.length,
      'panels that subscribe later get it in the snapshot',
    );
  });

  test('should check off a disclosure on the segment that satisfies it', () => {
    const hub = fakeHub();
    const pipeline = createPipeline({
      meetingId: 'meeting-A',
      pack: loadPack(path.join(shipped, 'fin-us-retail-v4.yaml')),
      config: { ruleSuppressionWindowSeconds: 60 },
      llm: null,
      hub,
      auditChain: { append: async () => {} },
      logger: { error: () => {} },
    });

    pipeline.onSegment({
      seqNo: 0,
      text: 'Do I have your consent to record?',
      speakerId: 1,
      speakerLabel: 'Rep',
      tStartMs: 1756200000000,
    });

    const latest = hub.disclosureBroadcasts.at(-1).disclosures;
    assert.equal(latest.find((d) => d.id === 'recording-consent').status, 'satisfied');
  });
});

describe('alert latency', () => {
  test('should broadcast an alert on the rule match, before adjudication finishes', async () => {
    const hub = fakeHub();
    const sent = [];
    hub.broadcastAlert = (_meetingId, alert) => sent.push(alert);

    let resolveModel;
    const llm = () =>
      new Promise((resolve) => {
        resolveModel = resolve;
      });

    const pipeline = createPipeline({
      meetingId: 'meeting-A',
      pack: loadPack(path.join(shipped, 'fin-us-retail-v4.yaml')),
      config: { ruleSuppressionWindowSeconds: 60, llmTimeoutMs: 5000 },
      llm,
      hub,
      auditChain: { append: async () => {} },
      logger: { error: () => {}, warn: () => {} },
    });

    pipeline.onSegment({
      seqNo: 3,
      text: 'We can offer a guaranteed return.',
      speakerId: 1,
      speakerLabel: 'Rep',
      tStartMs: 1756200000000,
    });

    assert.equal(sent.length, 1, 'sent synchronously, without waiting on the model');
    assert.equal(sent[0].pending, true);
    assert.equal(sent[0].ruleId, 'guaranteed-return');

    resolveModel(
      JSON.stringify({
        violation: true,
        confidence: 0.9,
        rationale: 'promise',
        suggestedLanguage: 'x',
      }),
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(sent.length, 2, 'the adjudicated version follows');
    assert.equal(sent[1].seqNo, 3);
    assert.equal(sent[1].adjudicated, true);
    assert.equal(hub.states.at(-1).state.alerts.length, 1, 'replaced, not appended');
  });
});

describe('adjudication off', () => {
  test('should send one final alert with no verdict UI and no model call', () => {
    const hub = fakeHub();
    const sent = [];
    hub.broadcastAlert = (_meetingId, alert) => sent.push(alert);

    const pipeline = createPipeline({
      meetingId: 'meeting-A',
      pack: loadPack(path.join(shipped, 'fin-us-retail-v4.yaml')),
      config: { ruleSuppressionWindowSeconds: 60 },
      llm: null,
      hub,
      auditChain: { append: async () => {} },
      logger: { error: () => {}, warn: () => {} },
    });

    pipeline.onSegment({
      seqNo: 0,
      text: 'We can offer a guaranteed return.',
      speakerId: 1,
      speakerLabel: 'Rep',
      tStartMs: 1756200000000,
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].adjudication, 'off');
    assert.equal(sent[0].pending, undefined);
    assert.equal(sent[0].rationale, null, 'no "not adjudicated" message');
    assert.ok(sent[0].suggestedLanguage, 'still shows the rule guidance');
  });
});
