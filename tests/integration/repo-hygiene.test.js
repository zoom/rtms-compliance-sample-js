import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Acceptance criteria 50, 53, plus credential-safety guarantees from the spec.
// These assert repository invariants, so they need no implementation to run.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('runtime requirements', () => {
  test('should declare an engines floor of Node 22', () => {
    const pkg = JSON.parse(read('package.json'));

    assert.equal(pkg.engines.node, '>=22.0.0');
  });

  test('should depend on @zoom/rtms', () => {
    const pkg = JSON.parse(read('package.json'));

    assert.ok(pkg.dependencies['@zoom/rtms'], 'the sample must build on the Zoom RTMS SDK');
  });

  test('should pin a Node version in .nvmrc', () => {
    assert.ok(exists('.nvmrc'), '.nvmrc pins the recommended Node version');
    assert.match(read('.nvmrc').trim(), /^(22|24)$/);
  });

  test('should declare the package as an ES module', () => {
    assert.equal(JSON.parse(read('package.json')).type, 'module');
  });
});

describe('Zoom for Government', () => {
  test('should not hardcode zoom.us outside src/config.js', () => {
    const sourceFiles = walk(path.join(ROOT, 'src'));

    // Without this guard the assertion below passes vacuously before any
    // source exists, which would report coverage the suite does not have.
    assert.ok(
      sourceFiles.length > 0,
      'src/ must contain source files for this check to mean anything',
    );

    const offenders = sourceFiles
      .filter((file) => !file.endsWith(path.join('src', 'config.js')))
      .filter((file) => read(path.relative(ROOT, file)).includes('zoom.us'))
      .map((file) => path.relative(ROOT, file));

    assert.deepEqual(
      offenders,
      [],
      `hardcoded zoom.us breaks Zoom for Government deployments: ${offenders.join(', ')}`,
    );
  });

  test('should document ZOOM_HOST in .env.example', () => {
    const env = read('.env.example');

    assert.match(env, /^ZOOM_HOST=/m);
    assert.ok(env.includes('zoomgov.com'), '.env.example must show the government value');
  });
});

describe('credential safety', () => {
  test('should gitignore .env before any commit', () => {
    const ignore = read('.gitignore');

    assert.match(ignore, /^\.env$/m);
  });

  test('should not ship a .env file', () => {
    assert.equal(exists('.env'), false, 'a committed .env is a credential leak');
  });

  test('should use obvious placeholders in .env.example', () => {
    const env = read('.env.example');
    const assignments = env
      .split('\n')
      .filter((line) => /^[A-Z0-9_]+=.+/.test(line))
      .map((line) => line.split('=').slice(1).join('='));

    assert.ok(assignments.length > 0, '.env.example must declare variables');

    // A leaked credential looks like a long opaque token: no URL scheme, no
    // spaces, and no placeholder marker. Model ids and DSNs are not that.
    const OPAQUE_TOKEN = /^[A-Za-z0-9+/=_-]{32,}$/;
    const PLACEHOLDER = /YOUR_|EXAMPLE|PLACEHOLDER|CHANGE_?ME/i;

    for (const value of assignments) {
      const looksReal = OPAQUE_TOKEN.test(value) && !PLACEHOLDER.test(value);
      assert.equal(looksReal, false, `.env.example value looks like a real credential: ${value}`);
    }
  });

  test('should document that .env storage is not production ready', () => {
    const env = read('.env.example');

    assert.match(env, /NOT PRODUCTION READY/i);
  });
});

describe('required repository files', () => {
  for (const file of [
    'README.md',
    'LICENSE.md',
    'CONTRIBUTING.md',
    'Dockerfile',
    '.env.example',
    '.gitignore',
    'manifest.json',
    'spec.md',
    '.github/dependabot.yml',
    '.github/workflows/ci.yml',
  ]) {
    test(`should include ${file}`, () => {
      assert.ok(exists(file), `${file} is required by the Zoom OSS standards`);
    });
  }
});

describe('Dockerfile', () => {
  test('should use a glibc base rather than Alpine', () => {
    // @zoom/rtms ships a glibc-linked native addon; musl cannot load it.
    const dockerfile = read('Dockerfile');

    assert.ok(!/FROM\s+\S*alpine/i.test(dockerfile), 'Alpine cannot load the RTMS native addon');
    assert.match(dockerfile, /FROM\s+\S*(debian|bookworm|slim|ubuntu)/i);
  });

  test('should be multi-stage', () => {
    const stages = read('Dockerfile').match(/^FROM /gm) ?? [];

    assert.ok(stages.length >= 2, 'the style guide requires a multi-stage build');
  });

  test('should EXPOSE a port and declare a CMD', () => {
    const dockerfile = read('Dockerfile');

    assert.match(dockerfile, /^EXPOSE /m);
    assert.match(dockerfile, /^(CMD|ENTRYPOINT) /m);
  });
});

describe('rule packs', () => {
  test('should ship the two packs the spec names', () => {
    assert.ok(exists(path.join('rule-packs', 'fin-us-retail-v3.yaml')));
    assert.ok(exists(path.join('rule-packs', 'health-us-intake-v1.yaml')));
  });

  test('should label shipped packs as examples, not compliance products', () => {
    for (const name of ['fin-us-retail-v3.yaml', 'health-us-intake-v1.yaml']) {
      const pack = read(path.join('rule-packs', name));
      assert.match(
        pack,
        /example|illustrative|not legal advice/i,
        `${name} must state that it is illustrative`,
      );
    }
  });
});
