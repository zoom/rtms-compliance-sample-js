#!/usr/bin/env node
/**
 * Write a .env from .env.example with generated secrets filled in.
 *
 *   npm run env:init          create .env, refuse if one exists
 *   npm run env:init -- --force   overwrite an existing .env
 *   npm run env:secrets       print generated values, write nothing
 *
 * Only values this process both issues and verifies are generated. Anything
 * Zoom issues is left as its placeholder, because a fabricated client secret
 * would trade a clear startup failure for a confusing 401 later.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Placeholders replaced with real random values.
 *
 * Only secrets this process both issues and verifies. SESSION_SECRET and
 * TOKEN_ENCRYPTION_KEY are absent because nothing reads them yet; see the
 * "Not used yet" section of .env.example.
 */
const GENERATE = ['JWT_SECRET'];

const newSecret = () => crypto.randomBytes(32).toString('hex');

const args = process.argv.slice(2);
const force = args.includes('--force');
const printOnly = args.includes('--print');

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const examplePath = path.join(root, '.env.example');
const envPath = path.join(root, '.env');

if (printOnly) {
  for (const name of GENERATE) console.log(`${name}=${newSecret()}`);
  process.exit(0);
}

if (!fs.existsSync(examplePath)) {
  console.error('  FAIL  .env.example not found. Run this from the repository root.');
  process.exit(1);
}

if (fs.existsSync(envPath) && !force) {
  console.error(
    '  FAIL  .env already exists. Refusing to overwrite it.\n' +
      '        Re-run with --force, or copy the values you want from:\n' +
      '          npm run env:secrets',
  );
  process.exit(1);
}

const generated = [];

const contents = fs
  .readFileSync(examplePath, 'utf8')
  .split('\n')
  .map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) return line;

    const [, name] = match;
    if (!GENERATE.includes(name)) return line;

    generated.push(name);
    return `${name}=${newSecret()}`;
  })
  .join('\n');

fs.writeFileSync(envPath, contents, { mode: 0o600 });

console.log(`  Wrote .env (mode 0600) with ${generated.length} generated secret(s):`);
for (const name of generated) console.log(`    ${name}`);

console.log(
  '\n  Still needs your values, from https://marketplace.zoom.us:\n' +
    '    ZM_RTMS_CLIENT          OAuth Client ID\n' +
    '    ZM_RTMS_SECRET          OAuth Client Secret\n' +
    '    ZM_RTMS_WEBHOOK_SECRET  Webhook Secret Token\n' +
    '    PUBLIC_URL              your ngrok domain\n' +
    '\n  LLM_API_KEY is optional; OpenRouter serves free models without one.\n' +
    '\n  .env is gitignored. Never commit it.',
);
