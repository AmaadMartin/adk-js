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
 * Names a counter by the line span it covers. Columns are deliberately left
 * out: a Windows checkout has CRLF line endings, so the byte offsets v8 reports
 * — and every column derived from them — are shifted against a Linux checkout
 * of identical source, and a column-sensitive key reports every file as
 * different.
 */
function lineSpan(loc) {
  return loc ? `lines ${loc.start.line}-${loc.end.line}` : 'unknown location';
}

/**
 * Records `unit -> covered?`, disambiguating counters that share a line span
 * (an inline ternary has both arms on one line) by their order within the
 * report, which both reports enumerate the same way.
 */
function addUnit(units, span, covered) {
  let unit = span;
  for (let n = 2; units.has(unit); n++) {
    unit = `${span} #${n}`;
  }
  units.set(unit, covered);
}

/**
 * Flattens one kind of counter into `unit -> covered?`. Units are keyed by
 * source position rather than by the numeric counter id because the id is only
 * an index into the report: when one report omits a counter the other has,
 * every later id shifts and an id-keyed comparison reports the whole tail as
 * different.
 *
 * A branch contributes one unit per arm, because v8 can cover one arm of a
 * conditional and not the other.
 */
function coverageUnits(entry, kind) {
  const units = new Map();
  if (kind === 'statements') {
    for (const [id, hits] of Object.entries(entry.s ?? {})) {
      addUnit(units, lineSpan(entry.statementMap?.[id]), hits > 0);
    }
  } else if (kind === 'functions') {
    for (const [id, hits] of Object.entries(entry.f ?? {})) {
      addUnit(units, lineSpan(entry.fnMap?.[id]?.decl), hits > 0);
    }
  } else {
    for (const [id, arms] of Object.entries(entry.b ?? {})) {
      const branch = entry.branchMap?.[id];
      arms.forEach((hits, arm) => {
        addUnit(
          units,
          lineSpan(branch?.locations?.[arm] ?? branch?.loc),
          hits > 0,
        );
      });
    }
  }
  return units;
}

/**
 * Units covered in `a` but not in `b`, and vice versa, plus the units one
 * report has no counter for at all. A missing unit is reported rather than
 * skipped: the two reports then disagree on how many statements, branches or
 * functions the file even has, which moves the percentage through the
 * denominator.
 */
function diffUnits(a, b) {
  const onlyA = [];
  const onlyB = [];
  const absentFromB = [];
  for (const [unit, coveredInA] of a) {
    if (!b.has(unit)) {
      absentFromB.push(unit);
    } else if (coveredInA && !b.get(unit)) {
      onlyA.push(unit);
    } else if (!coveredInA && b.get(unit)) {
      onlyB.push(unit);
    }
  }
  const absentFromA = [...b.keys()].filter((unit) => !a.has(unit));
  return {onlyA, onlyB, absentFromA, absentFromB};
}

function diffFile(entryA, entryB) {
  const differences = [];
  for (const kind of ['statements', 'branches', 'functions']) {
    const diff = diffUnits(
      coverageUnits(entryA, kind),
      coverageUnits(entryB, kind),
    );
    if (Object.values(diff).some((units) => units.length > 0)) {
      differences.push({kind, ...diff});
    }
  }
  return differences;
}

function printFileDiff(path, differences) {
  const summary = differences
    .map(({kind, onlyA, onlyB, absentFromA, absentFromB}) => {
      const absent = absentFromB.length + absentFromA.length;
      const counted =
        absent > 0 ? ` (${absent} counted in one report only)` : '';
      return `${kind} +${onlyA.length}/-${onlyB.length}${counted}`;
    })
    .join('  ');
  console.log(`${path}  ${summary}`);
  for (const {kind, onlyA, onlyB, absentFromA, absentFromB} of differences) {
    for (const [label, units] of [
      ['+', onlyA],
      ['-', onlyB],
      ['only counted in A:', absentFromB],
      ['only counted in B:', absentFromA],
    ]) {
      for (const unit of units) {
        console.log(`  ${label} ${kind} at ${unit}`);
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
      printFileDiff(path, differences);
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
