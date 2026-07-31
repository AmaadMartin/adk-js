/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Compares two `coverage/coverage-final.json` reports and prints every file
 * whose *coverage shape* differs, i.e. some statement, branch arm or function
 * is covered in one report and not in the other.
 *
 * Hit counts are deliberately ignored: they vary legitimately with test order
 * and retries. Only the zero / non-zero pattern is compared, because that is
 * what moves the percentages the `coverage.thresholds` gate is set from.
 *
 * Usage: node scripts/diff_coverage.mjs <a.json> <b.json>
 */

import {readFileSync} from 'node:fs';

/** Path segments a repo-relative source path can start with. */
const SOURCE_ROOTS = ['core', 'dev', 'integrations'];

const REPO_RELATIVE = new RegExp(`(?:^|/)((?:${SOURCE_ROOTS.join('|')})/.*)$`);

/**
 * Turns an absolute, OS-specific report key into a forward-slash,
 * repo-relative path so a Windows report can be compared with a Linux one.
 */
function normalizeKey(key) {
  const posix = key.replaceAll('\\', '/');
  const match = REPO_RELATIVE.exec(posix);
  return match ? match[1] : posix;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function readReport(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`diff_coverage: cannot read ${file}: ${errorMessage(error)}`);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(
      `diff_coverage: cannot parse ${file} as JSON: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

function byNormalizedKey(report) {
  const byKey = new Map();
  for (const [key, entry] of Object.entries(report)) {
    byKey.set(normalizeKey(key), entry);
  }
  return byKey;
}

/**
 * Flattens one coverage counter map into `unit id -> covered?`. A branch
 * contributes one unit per arm (`"3/1"` is arm 1 of branch 3) because v8 can
 * cover one arm of a conditional and not the other.
 */
function coverageUnits(counters) {
  const units = new Map();
  for (const [id, hits] of Object.entries(counters ?? {})) {
    if (Array.isArray(hits)) {
      hits.forEach((armHits, arm) => units.set(`${id}/${arm}`, armHits > 0));
    } else {
      units.set(id, hits > 0);
    }
  }
  return units;
}

/** Resolves the source line a unit id points at, for the detail lines. */
function unitLine(kind, entry, unitId) {
  const [id, arm] = unitId.split('/');
  if (kind === 'statements') {
    return entry.statementMap?.[id]?.start?.line;
  }
  if (kind === 'functions') {
    return entry.fnMap?.[id]?.decl?.start?.line;
  }
  const location = entry.branchMap?.[id];
  return (
    location?.locations?.[Number(arm)]?.start?.line ??
    location?.loc?.start?.line
  );
}

/** Units covered in `a` but not in `b`, and vice versa. Common ids only. */
function diffUnits(a, b) {
  const onlyA = [];
  const onlyB = [];
  for (const [unitId, coveredInA] of a) {
    if (!b.has(unitId)) {
      continue;
    }
    if (coveredInA && !b.get(unitId)) {
      onlyA.push(unitId);
    } else if (!coveredInA && b.get(unitId)) {
      onlyB.push(unitId);
    }
  }
  return {onlyA, onlyB};
}

function diffFile(entryA, entryB) {
  const kinds = [
    ['statements', 's'],
    ['branches', 'b'],
    ['functions', 'f'],
  ];
  const differences = [];
  for (const [kind, counter] of kinds) {
    const {onlyA, onlyB} = diffUnits(
      coverageUnits(entryA[counter]),
      coverageUnits(entryB[counter]),
    );
    if (onlyA.length > 0 || onlyB.length > 0) {
      differences.push({kind, onlyA, onlyB});
    }
  }
  return differences;
}

function printFileDiff(path, entryA, differences) {
  const summary = differences
    .map(({kind, onlyA, onlyB}) => `${kind} +${onlyA.length}/-${onlyB.length}`)
    .join('  ');
  console.log(`${path}  ${summary}`);
  for (const {kind, onlyA, onlyB} of differences) {
    for (const [sign, unitIds] of [
      ['+', onlyA],
      ['-', onlyB],
    ]) {
      for (const unitId of unitIds) {
        console.log(
          `  ${sign} ${kind} ${unitId} at line ${unitLine(kind, entryA, unitId)}`,
        );
      }
    }
  }
}

function main(argv) {
  const [fileA, fileB] = argv;
  if (!fileA || !fileB) {
    console.error(
      'diff_coverage: usage: node scripts/diff_coverage.mjs <a.json> <b.json>',
    );
    process.exitCode = 1;
    return;
  }

  const reportA = readReport(fileA);
  const reportB = readReport(fileB);
  if (!reportA || !reportB) {
    process.exitCode = 1;
    return;
  }

  const a = byNormalizedKey(reportA);
  const b = byNormalizedKey(reportB);

  console.log(`A: ${fileA}`);
  console.log(`B: ${fileB}`);
  console.log('+ = covered in A only, - = covered in B only\n');

  let differingFiles = 0;
  for (const [path, entryA] of [...a].sort(([x], [y]) => x.localeCompare(y))) {
    const entryB = b.get(path);
    if (!entryB) {
      console.log(`${path}  only in A`);
      differingFiles++;
      continue;
    }
    const differences = diffFile(entryA, entryB);
    if (differences.length > 0) {
      printFileDiff(path, entryA, differences);
      differingFiles++;
    }
  }
  for (const path of [...b.keys()].sort()) {
    if (!a.has(path)) {
      console.log(`${path}  only in B`);
      differingFiles++;
    }
  }

  console.log(
    differingFiles === 0
      ? '\nNo differing files.'
      : `\n${differingFiles} differing file(s).`,
  );
}

main(process.argv.slice(2));
