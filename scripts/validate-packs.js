#!/usr/bin/env node
/**
 * Validate every rule pack in rule-packs/ (or a path given as an argument).
 *
 * Run in CI so a pack that would crash the service at boot fails the PR
 * instead. Exits non-zero on the first invalid pack.
 */
import path from 'node:path';
import { loadPackDir, PackValidationError } from '../src/compliance/packs.js';

const dir = path.resolve(process.argv[2] ?? 'rule-packs');

try {
  const packs = loadPackDir(dir);

  for (const [id, pack] of packs) {
    const rules = pack.prohibited.length;
    const disclosures = pack.requiredDisclosures.length;
    console.log(`  OK    ${id}  (${rules} prohibited, ${disclosures} required disclosures)`);
  }

  if (packs.size === 0) {
    console.error(`  FAIL  no rule packs found in ${dir}`);
    process.exit(1);
  }

  console.log(`\n${packs.size} pack(s) valid.`);
} catch (err) {
  if (err instanceof PackValidationError) {
    console.error(`  FAIL  ${err.file ?? dir}`);
    if (err.field) console.error(`        field: ${err.field}`);
    console.error(`        ${err.message}`);
    process.exit(1);
  }
  throw err;
}
