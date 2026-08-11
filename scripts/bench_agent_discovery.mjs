/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Measures where `AgentLoader.listAgents()` spends its time on a directory of
 * agents, so that everyone who changes `dev/src/utils/agent_loader.ts` reports
 * the same numbers. It splits the call into three wall-clock segments - the
 * work before the first esbuild build, the build window itself, and everything
 * after the last build - and reports the minimum and the median over N runs,
 * plus the compiled size of each agent bundle. Run it by hand; it is not part
 * of the test suite or of CI.
 *
 *   npm run build
 *   npm install --prefix tests/integration/app_loader/discovery
 *   node scripts/bench_agent_discovery.mjs [--dir <path>] [--runs <n>]
 *
 * The script imports the built loader from `dev/dist`, so `npm run build` must
 * run first, and the agents directory must already have its own dependencies
 * installed. The three segments tile the end-to-end call exactly, so nothing
 * hides in a residual, but they are segments and not phase costs: the loader
 * compiles and imports every agent concurrently, so an agent whose build ends
 * early imports itself inside the compile window and its import cost lands in
 * the compile row. Every run keeps its evaluated bundles in memory, so a large
 * `--runs` may need `--max-old-space-size`.
 */

import {stat} from 'node:fs/promises';
import Module, {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const AGENT_LOADER_PATH = path.join(
  REPO_ROOT,
  'dev/dist/esm/utils/agent_loader.js',
);
const DEFAULT_AGENTS_DIR = path.join(
  REPO_ROOT,
  'tests/integration/app_loader/discovery',
);
const DEFAULT_RUNS = 5;
const WARMUP_RUNS = 1;
const ENTRY_FILE_NAMES = ['app', 'agent'];
const PHASE_ROWS = [
  ['discovery + setup (before the first build)', 'setupMs'],
  ['compile (esbuild, concurrent wall)', 'compileMs'],
  ['import (bundles, after the last build)', 'importMs'],
  ['end-to-end listAgents()', 'e2eMs'],
];
const LABEL_WIDTH = 44;
const NUMBER_WIDTH = 12;
const USAGE = `Usage: node scripts/bench_agent_discovery.mjs [options]

  --dir <path>   agents directory to measure
                 (default: ${DEFAULT_AGENTS_DIR})
  --runs <n>     timed runs, after ${WARMUP_RUNS} untimed warm-up run
                 (default: ${DEFAULT_RUNS})
  --help         print this message`;

/** Every `esbuild.build()` call the probe saw during the current run. */
const recordedBuilds = [];

/** Set by {@link installBuildProbe} and cleared by {@link restoreBuildProbe}. */
let probe;

function parseCliArgs() {
  const {values} = parseArgs({
    options: {
      dir: {type: 'string', default: DEFAULT_AGENTS_DIR},
      runs: {type: 'string', default: String(DEFAULT_RUNS)},
      help: {type: 'boolean', default: false},
    },
  });

  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`--runs must be an integer >= 1, got '${values.runs}'.`);
  }

  return {dir: values.dir, runs, help: values.help};
}

function errorMessage(e) {
  return e instanceof Error ? e.message : String(e);
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function statOrUndefined(target) {
  try {
    return await stat(target);
  } catch {
    return undefined;
  }
}

async function findPreconditionProblem(agentsDir) {
  const loaderStats = await statOrUndefined(AGENT_LOADER_PATH);
  if (!loaderStats?.isFile()) {
    return `${AGENT_LOADER_PATH} is missing: run 'npm run build' first.`;
  }

  const dirStats = await statOrUndefined(agentsDir);
  if (!dirStats?.isDirectory()) {
    return `${agentsDir} is not a directory: pass an existing --dir.`;
  }

  return undefined;
}

/** Mirrors how `AgentLoader` names an agent after its file or its directory. */
function agentNameFor(entryPoint) {
  const parsed = path.parse(entryPoint);
  return ENTRY_FILE_NAMES.includes(parsed.name)
    ? path.basename(parsed.dir)
    : parsed.name;
}

/**
 * The loader deletes the bundle of a file that compiled but exported no agent,
 * so such a build has no size to report.
 */
async function bundleReport(build) {
  const stats = await statOrUndefined(build.outfile);
  return stats
    ? {name: agentNameFor(build.entryPoint), bytes: stats.size}
    : undefined;
}

async function probedBuild(options) {
  const record = {
    entryPoint: options.entryPoints[0],
    outfile: options.outfile,
    start: performance.now(),
    end: 0,
  };

  try {
    return await probe.realBuild(options);
  } finally {
    record.end = performance.now();
    recordedBuilds.push(record);
  }
}

/**
 * Times the builds without touching the loader, by swapping the esbuild module
 * the loader is about to import for one whose `build` is wrapped. It swaps the
 * whole CommonJS module record because esbuild exports `build` as a
 * non-configurable getter, so neither assignment nor `defineProperty` works on
 * the real module. Install this before importing the loader: replacing the
 * record has no effect once the loader holds the real module.
 */
function installBuildProbe(requireFromLoader) {
  const esbuildPath = requireFromLoader.resolve('esbuild');
  const realEsbuild = requireFromLoader('esbuild');

  const descriptors = Object.getOwnPropertyDescriptors(realEsbuild);
  descriptors.build = {value: probedBuild, enumerable: true};
  const probedRecord = new Module(esbuildPath, null);
  probedRecord.filename = esbuildPath;
  probedRecord.loaded = true;
  probedRecord.exports = Object.defineProperties({}, descriptors);

  probe = {
    require: requireFromLoader,
    esbuildPath,
    realRecord: requireFromLoader.cache[esbuildPath],
    realBuild: realEsbuild.build,
  };
  requireFromLoader.cache[esbuildPath] = probedRecord;
}

function restoreBuildProbe() {
  if (!probe) {
    return;
  }

  probe.require.cache[probe.esbuildPath] = probe.realRecord;
  probe = undefined;
}

function assertProbeAttached() {
  if (recordedBuilds.length > 0) {
    return;
  }

  throw new Error(
    'the esbuild instrumentation did not attach: no esbuild.build call was ' +
      'recorded. Re-check how dev/src/utils/agent_loader.ts calls esbuild.',
  );
}

/**
 * `listAgents()` records per-agent failures instead of throwing, so a broken
 * agents directory otherwise yields a fast and meaningless empty run.
 */
function assertEverythingLoaded(agentsDir, loadedNames, failures) {
  if (failures.length > 0) {
    const details = failures
      .map((f) => `  ${f.name} (${f.filePath}): ${f.error.message}`)
      .join('\n');
    throw new Error(
      `agents failed to load, so the run is not measurable:\n${details}`,
    );
  }

  if (loadedNames.length === 0) {
    throw new Error(`no agent loaded from ${agentsDir}: nothing to measure.`);
  }
}

async function runOnce(agentsDir, AgentLoader) {
  recordedBuilds.length = 0;
  const loader = new AgentLoader(agentsDir);

  try {
    const startedAt = performance.now();
    const loadedNames = await loader.listAgents();
    const endedAt = performance.now();

    assertProbeAttached();
    assertEverythingLoaded(
      agentsDir,
      loadedNames,
      await loader.listLoadFailures(),
    );

    const builds = [...recordedBuilds];
    const firstBuildStart = Math.min(...builds.map((build) => build.start));
    const lastBuildEnd = Math.max(...builds.map((build) => build.end));
    const bundles = (await Promise.all(builds.map(bundleReport))).filter(
      (bundle) => bundle !== undefined,
    );

    return {
      compiled: builds.length,
      loaded: loadedNames.length,
      bundles,
      sample: {
        setupMs: firstBuildStart - startedAt,
        compileMs: lastBuildEnd - firstBuildStart,
        importMs: endedAt - lastBuildEnd,
        e2eMs: endedAt - startedAt,
      },
    };
  } finally {
    await loader.disposeAll();
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatMs(value) {
  return value.toFixed(1);
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function formatRow(label, minText, medianText) {
  return `  ${label.padEnd(LABEL_WIDTH)}${minText.padStart(NUMBER_WIDTH)}${medianText.padStart(NUMBER_WIDTH)}`;
}

function printReport(agentsDir, timedRuns, results) {
  const last = results[results.length - 1];

  console.log('agent discovery benchmark');
  console.log(`  agents dir  : ${agentsDir}`);
  console.log(
    `  entrypoints : ${last.compiled} compiled, ${last.loaded} loaded`,
  );
  console.log(`  runs        : ${timedRuns} timed (${WARMUP_RUNS} warm-up)`);
  console.log(
    `  node        : ${process.version} ${process.platform}/${process.arch}, ${os.cpus().length} cpus`,
  );
  if (last.compiled !== last.loaded) {
    console.log(
      `  note        : the counts differ, so ${agentsDir} also holds files that export no agent.`,
    );
  }

  console.log('');
  console.log(formatRow('phase', 'min (ms)', 'median (ms)'));
  for (const [label, key] of PHASE_ROWS) {
    const values = results.map((result) => result.sample[key]);
    console.log(
      formatRow(label, formatMs(Math.min(...values)), formatMs(median(values))),
    );
  }
  console.log(
    "  each run's three segments tile its end-to-end time; a build that ends",
  );
  console.log('  early overlaps its own import with the compile window.');

  console.log('');
  console.log('  per-agent compiled bundle size');
  const bundles = [...last.bundles].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const bundle of bundles) {
    console.log(
      `    ${bundle.name.padEnd(LABEL_WIDTH - 2)}${formatBytes(bundle.bytes).padStart(NUMBER_WIDTH)}`,
    );
  }
}

async function main() {
  // Every AgentLoader adds five process listeners and never removes them, so a
  // multi-run benchmark would otherwise flood the report with warnings.
  process.setMaxListeners(0);

  let args;
  try {
    args = parseCliArgs();
  } catch (e) {
    return fail(errorMessage(e));
  }

  if (args.help) {
    console.log(USAGE);
    return;
  }

  const agentsDir = path.resolve(args.dir);
  const problem = await findPreconditionProblem(agentsDir);
  if (problem) {
    return fail(problem);
  }

  // Anchoring the resolution at the loader guarantees the same esbuild module
  // instance even if a second copy is ever nested under dev/node_modules.
  const loaderUrl = pathToFileURL(AGENT_LOADER_PATH).href;
  try {
    installBuildProbe(createRequire(loaderUrl));
    const {AgentLoader} = await import(loaderUrl);

    for (let run = 0; run < WARMUP_RUNS; run++) {
      await runOnce(agentsDir, AgentLoader);
    }

    const results = [];
    for (let run = 0; run < args.runs; run++) {
      results.push(await runOnce(agentsDir, AgentLoader));
    }

    printReport(agentsDir, args.runs, results);
  } catch (e) {
    return fail(errorMessage(e));
  } finally {
    restoreBuildProbe();
  }
}

await main();
