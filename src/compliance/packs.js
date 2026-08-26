/**
 * Rule pack loading.
 *
 * A rule pack is the contract between a compliance team and this code.
 * Compliance owns the YAML; engineering owns this loader.
 *
 * The loader fails closed. Screening a live regulated call with a partially
 * parsed pack would produce an audit log that implies full coverage the app
 * never had, which is worse than not running at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/** Thrown for any pack that cannot be trusted. Names the file and field. */
export class PackValidationError extends Error {
  constructor(message, { file, field } = {}) {
    super(message);
    this.name = 'PackValidationError';
    this.file = file;
    this.field = field;
  }
}

const SEVERITIES = new Set(['high', 'medium', 'low']);

function requireString(value, { file, field }) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PackValidationError(`${field} must be a non-empty string`, { file, field });
  }
  return value.trim();
}

function requireSeverity(value, { file, field }) {
  const severity = requireString(value, { file, field });
  if (!SEVERITIES.has(severity)) {
    throw new PackValidationError(
      `${field} must be one of: ${[...SEVERITIES].join(', ')}. Got: ${severity}`,
      { file, field },
    );
  }
  return severity;
}

function requirePhrases(value, { file, field }) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PackValidationError(`${field} must be a non-empty array`, { file, field });
  }

  // Compile once, here. Screening runs on every transcript segment of every
  // live meeting; compiling per segment would put a regex parser on the hot
  // path for no reason.
  return value.map((phrase, i) => {
    const source = requireString(phrase, { file, field: `${field}[${i}]` });
    try {
      return new RegExp(source, 'i');
    } catch (err) {
      throw new PackValidationError(`${field}[${i}] is not a valid pattern: ${err.message}`, {
        file,
        field: `${field}[${i}]`,
      });
    }
  });
}

/**
 * Load and compile one rule pack.
 *
 * @param {string} filePath path to a pack YAML file
 * @returns {object} compiled pack
 * @throws {PackValidationError} on any problem at all
 */
export function loadPack(filePath) {
  const file = filePath;

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new PackValidationError(`cannot read rule pack: ${err.message}`, { file });
  }

  let doc;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    throw new PackValidationError(`invalid YAML: ${err.message}`, { file });
  }

  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new PackValidationError('rule pack must be a YAML mapping', { file });
  }

  const id = requireString(doc.id, { file, field: 'id' });

  const prohibited = (doc.prohibited ?? []).map((rule, i) => {
    const field = (name) => `prohibited[${i}].${name}`;
    if (rule == null || typeof rule !== 'object') {
      throw new PackValidationError(`prohibited[${i}] must be a mapping`, {
        file,
        field: `prohibited[${i}]`,
      });
    }
    return {
      id: requireString(rule.id, { file, field: field('id') }),
      severity: requireSeverity(rule.severity, { file, field: field('severity') }),
      guidance: requireString(rule.guidance, { file, field: field('guidance') }),
      patterns: requirePhrases(rule.match, { file, field: field('match') }),
    };
  });

  const requiredDisclosures = (doc.required_disclosures ?? []).map((disclosure, i) => {
    const field = (name) => `required_disclosures[${i}].${name}`;
    if (disclosure == null || typeof disclosure !== 'object') {
      throw new PackValidationError(`required_disclosures[${i}] must be a mapping`, {
        file,
        field: `required_disclosures[${i}]`,
      });
    }
    return {
      id: requireString(disclosure.id, { file, field: field('id') }),
      severity: requireSeverity(disclosure.severity, { file, field: field('severity') }),
      prompt: requireString(disclosure.prompt, { file, field: field('prompt') }),
      patterns: requirePhrases(disclosure.satisfied_by, { file, field: field('satisfied_by') }),
    };
  });

  if (prohibited.length === 0 && requiredDisclosures.length === 0) {
    throw new PackValidationError('rule pack has no prohibited rules and no required disclosures', {
      file,
      field: 'prohibited',
    });
  }

  return {
    id,
    jurisdiction: doc.jurisdiction ?? null,
    appliesTo: Array.isArray(doc.applies_to) ? doc.applies_to : [],
    prohibited,
    requiredDisclosures,
  };
}

/**
 * Load every YAML pack in a directory.
 *
 * One bad pack rejects the whole directory. Starting with a subset of the
 * configured packs would mean some meetings are screened against rules that
 * silently are not there.
 *
 * @param {string} dir
 * @returns {Map<string, object>} packs by id
 */
export function loadPackDir(dir) {
  const packs = new Map();

  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();

  for (const file of entries) {
    const pack = loadPack(file);
    if (packs.has(pack.id)) {
      throw new PackValidationError(`duplicate rule pack id: ${pack.id}`, { file, field: 'id' });
    }
    packs.set(pack.id, pack);
  }

  return packs;
}
