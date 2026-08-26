import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPrompt,
  parseVerdict,
  adjudicate,
  PROMPT_VERSION,
} from '../../src/compliance/adjudicate.js';

// Acceptance criteria 25-30.

const RULE = {
  id: 'guaranteed-return',
  severity: 'high',
  guidance: 'Past performance does not guarantee future results. Restate as a historical range.',
};

const CANDIDATE = {
  ruleId: 'guaranteed-return',
  severity: 'high',
  matchedText: 'guaranteed return',
  seqNo: 12,
};

const CONTEXT = 'Rep: thanks for your time. Rep: we can offer a guaranteed return on this fund.';

const VALID_VERDICT = {
  violation: true,
  confidence: 0.91,
  rationale: 'The representative promised a guaranteed return.',
  suggested_language: 'Past performance does not guarantee future results.',
};

const llmReturning =
  (raw, { delayMs = 0 } = {}) =>
  async () => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return raw;
  };

describe('buildPrompt', () => {
  test('should include the rule guidance so suggestions match approved language', () => {
    const prompt = buildPrompt({ rule: RULE, candidate: CANDIDATE, context: CONTEXT });

    assert.ok(prompt.includes(RULE.guidance));
  });

  test('should include the rule id and severity', () => {
    const prompt = buildPrompt({ rule: RULE, candidate: CANDIDATE, context: CONTEXT });

    assert.ok(prompt.includes('guaranteed-return'));
    assert.ok(prompt.includes('high'));
  });

  test('should include the matched phrase and the surrounding context', () => {
    const prompt = buildPrompt({ rule: RULE, candidate: CANDIDATE, context: CONTEXT });

    assert.ok(prompt.includes('guaranteed return'));
    assert.ok(prompt.includes(CONTEXT));
  });

  test('should instruct the model to return JSON only', () => {
    const prompt = buildPrompt({ rule: RULE, candidate: CANDIDATE, context: CONTEXT });

    assert.match(prompt, /JSON only/i);
  });
});

describe('parseVerdict', () => {
  test('should parse a bare JSON object', () => {
    const verdict = parseVerdict(JSON.stringify(VALID_VERDICT));

    assert.equal(verdict.violation, true);
    assert.equal(verdict.confidence, 0.91);
    assert.equal(verdict.suggestedLanguage, 'Past performance does not guarantee future results.');
  });

  test('should parse JSON wrapped in markdown fences', () => {
    const verdict = parseVerdict('```json\n' + JSON.stringify(VALID_VERDICT) + '\n```');

    assert.equal(verdict.violation, true);
    assert.equal(verdict.confidence, 0.91);
  });

  test('should parse JSON wrapped in unlabeled fences', () => {
    const verdict = parseVerdict('```\n' + JSON.stringify(VALID_VERDICT) + '\n```');

    assert.equal(verdict.violation, true);
  });

  test('should parse JSON with leading prose the model added anyway', () => {
    const verdict = parseVerdict('Here is my assessment:\n' + JSON.stringify(VALID_VERDICT));

    assert.equal(verdict.violation, true);
  });

  test('should throw on unparseable output', () => {
    assert.throws(() => parseVerdict('I think this is probably fine, honestly.'));
  });

  test('should throw when violation is absent', () => {
    assert.throws(() => parseVerdict(JSON.stringify({ confidence: 0.5 })));
  });
});

describe('adjudicate', () => {
  test('should return an alert marked adjudicated on a valid verdict', async () => {
    const alert = await adjudicate({
      candidate: CANDIDATE,
      rule: RULE,
      context: CONTEXT,
      llm: llmReturning(JSON.stringify(VALID_VERDICT)),
      timeoutMs: 5000,
      modelId: 'anthropic/claude-sonnet-5',
    });

    assert.equal(alert.adjudicated, true);
    assert.equal(alert.violation, true);
    assert.equal(alert.confidence, 0.91);
  });

  test('should record the model id on every alert', async () => {
    const alert = await adjudicate({
      candidate: CANDIDATE,
      rule: RULE,
      context: CONTEXT,
      llm: llmReturning(JSON.stringify(VALID_VERDICT)),
      timeoutMs: 5000,
      modelId: 'anthropic/claude-sonnet-5',
    });

    assert.equal(alert.modelId, 'anthropic/claude-sonnet-5');
  });

  test('should record the prompt version on every alert', async () => {
    const alert = await adjudicate({
      candidate: CANDIDATE,
      rule: RULE,
      context: CONTEXT,
      llm: llmReturning(JSON.stringify(VALID_VERDICT)),
      timeoutMs: 5000,
      modelId: 'anthropic/claude-sonnet-5',
    });

    assert.equal(alert.promptVersion, PROMPT_VERSION);
    assert.ok(PROMPT_VERSION, 'PROMPT_VERSION must be a non-empty identifier');
  });

  test('should emit the alert with confidence 0 when the model returns malformed JSON', async () => {
    const alert = await adjudicate({
      candidate: CANDIDATE,
      rule: RULE,
      context: CONTEXT,
      llm: llmReturning('not json at all'),
      timeoutMs: 5000,
      modelId: 'anthropic/claude-sonnet-5',
    });

    assert.equal(alert.confidence, 0);
    assert.equal(alert.adjudicated, false);
    assert.equal(alert.ruleId, 'guaranteed-return', 'the alert must still be emitted, not dropped');
  });

  test('should emit the alert with confidence 0 when the model call times out', async () => {
    const alert = await adjudicate({
      candidate: CANDIDATE,
      rule: RULE,
      context: CONTEXT,
      llm: llmReturning(JSON.stringify(VALID_VERDICT), { delayMs: 200 }),
      timeoutMs: 20,
      modelId: 'anthropic/claude-sonnet-5',
    });

    assert.equal(alert.adjudicated, false);
    assert.equal(alert.confidence, 0);
    assert.equal(alert.ruleId, 'guaranteed-return');
  });

  test('should emit the alert when the model call rejects outright', async () => {
    const alert = await adjudicate({
      candidate: CANDIDATE,
      rule: RULE,
      context: CONTEXT,
      llm: async () => {
        throw new Error('502 from provider');
      },
      timeoutMs: 5000,
      modelId: 'anthropic/claude-sonnet-5',
    });

    assert.equal(alert.adjudicated, false);
    assert.equal(alert.ruleId, 'guaranteed-return');
  });

  test('should preserve the deterministic ruleId when the verdict is not a violation', async () => {
    // The model can downgrade an alert. It can never erase the fact that a
    // deterministic rule matched; an auditor needs both halves.
    const alert = await adjudicate({
      candidate: CANDIDATE,
      rule: RULE,
      context: CONTEXT,
      llm: llmReturning(JSON.stringify({ ...VALID_VERDICT, violation: false })),
      timeoutMs: 5000,
      modelId: 'anthropic/claude-sonnet-5',
    });

    assert.equal(alert.violation, false);
    assert.equal(alert.ruleId, 'guaranteed-return');
    assert.equal(alert.severity, 'high');
    assert.equal(alert.quote, 'guaranteed return');
  });

  test('should carry the segment sequence number through to the alert', async () => {
    const alert = await adjudicate({
      candidate: CANDIDATE,
      rule: RULE,
      context: CONTEXT,
      llm: llmReturning(JSON.stringify(VALID_VERDICT)),
      timeoutMs: 5000,
      modelId: 'anthropic/claude-sonnet-5',
    });

    assert.equal(alert.seqNo, 12);
  });
});
