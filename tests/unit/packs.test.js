import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPack, loadPackDir, PackValidationError } from '../../src/compliance/packs.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'packs');
const fixture = (name) => path.join(FIXTURES, name);

// Acceptance criteria 19-20.

describe('loadPack', () => {
  test('should load a valid pack with its id and jurisdiction', () => {
    const pack = loadPack(fixture('valid-pack.yaml'));

    assert.equal(pack.id, 'test-pack-v1');
    assert.equal(pack.jurisdiction, 'US');
    assert.deepEqual(pack.appliesTo, ['unit-test']);
  });

  test('should load every prohibited rule with id, severity, and guidance', () => {
    const pack = loadPack(fixture('valid-pack.yaml'));

    assert.equal(pack.prohibited.length, 2);
    const rule = pack.prohibited.find((r) => r.id === 'guaranteed-return');
    assert.equal(rule.severity, 'high');
    assert.equal(rule.guidance, 'Past performance does not guarantee future results.');
  });

  test('should load every required disclosure with its prompt', () => {
    const pack = loadPack(fixture('valid-pack.yaml'));

    assert.equal(pack.requiredDisclosures.length, 2);
    const disclosure = pack.requiredDisclosures.find((d) => d.id === 'recording-consent');
    assert.equal(disclosure.severity, 'high');
    assert.equal(disclosure.prompt, 'Confirm verbal consent to record before continuing.');
  });

  test('should compile match strings into RegExp objects at load time', () => {
    const pack = loadPack(fixture('valid-pack.yaml'));
    const rule = pack.prohibited.find((r) => r.id === 'guaranteed-return');

    assert.ok(Array.isArray(rule.patterns));
    assert.equal(rule.patterns.length, 2);
    for (const pattern of rule.patterns) {
      assert.ok(pattern instanceof RegExp, 'patterns must be compiled once at load, not per segment');
    }
  });

  test('should compile patterns that honor the regex syntax in the pack', () => {
    const pack = loadPack(fixture('valid-pack.yaml'));
    const rule = pack.prohibited.find((r) => r.id === 'guaranteed-return');

    // "risk[- ]free" must match both spellings.
    assert.ok(rule.patterns.some((p) => p.test('this is risk-free')));
    assert.ok(rule.patterns.some((p) => p.test('this is risk free')));
  });

  test('should throw PackValidationError naming the file on malformed YAML', () => {
    assert.throws(
      () => loadPack(fixture('malformed.yaml')),
      (err) => {
        assert.ok(err instanceof PackValidationError);
        assert.match(err.file, /malformed\.yaml$/);
        return true;
      },
    );
  });

  test('should throw PackValidationError naming the field when id is missing', () => {
    assert.throws(
      () => loadPack(fixture('missing-id.yaml')),
      (err) => {
        assert.ok(err instanceof PackValidationError);
        assert.equal(err.field, 'id');
        assert.match(err.file, /missing-id\.yaml$/);
        return true;
      },
    );
  });

  test('should throw PackValidationError when a rule is missing severity', () => {
    assert.throws(
      () => loadPack(fixture('rule-missing-severity.yaml')),
      (err) => {
        assert.ok(err instanceof PackValidationError);
        assert.match(err.field, /severity/);
        return true;
      },
    );
  });

  test('should throw rather than return partial rules on a bad pack', () => {
    // Screening with a half-loaded pack produces an audit log that falsely
    // implies full coverage. Failing closed is the whole point.
    let returned;
    try {
      returned = loadPack(fixture('rule-missing-severity.yaml'));
    } catch {
      returned = undefined;
    }
    assert.equal(returned, undefined);
  });

  test('should throw PackValidationError for a nonexistent file', () => {
    assert.throws(() => loadPack(fixture('does-not-exist.yaml')), PackValidationError);
  });
});

describe('loadPackDir', () => {
  test('should reject the whole directory when any pack is invalid', () => {
    // Fixture dir intentionally contains invalid packs alongside the valid one.
    assert.throws(() => loadPackDir(FIXTURES), PackValidationError);
  });
});

describe('shipped rule packs', () => {
  const shipped = path.join(FIXTURES, '..', '..', '..', 'rule-packs');

  test('should load fin-us-retail-v3 without error', () => {
    const pack = loadPack(path.join(shipped, 'fin-us-retail-v3.yaml'));
    assert.equal(pack.id, 'fin-us-retail-v3');
  });

  test('should load health-us-intake-v1 without error', () => {
    const pack = loadPack(path.join(shipped, 'health-us-intake-v1.yaml'));
    assert.equal(pack.id, 'health-us-intake-v1');
  });

  test('should carry a version suffix in every shipped pack id', () => {
    // Packs are versioned artifacts, never edited in place.
    for (const name of ['fin-us-retail-v3.yaml', 'health-us-intake-v1.yaml']) {
      const pack = loadPack(path.join(shipped, name));
      assert.match(pack.id, /-v\d+$/, `${name} id must end in a version suffix`);
    }
  });
});
