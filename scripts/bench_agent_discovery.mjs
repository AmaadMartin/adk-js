/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Measures where `AgentLoader.listAgents()` spends its time on a directory of
 * agents, so that everyone who changes `dev/src/utils/agent_loader.ts` reports
 * the same numbers. It times the discovery scan, the real `esbuild.build()`
 * calls, an `await import()` pass over the compiled bundles and the end-to-end
 * call, and reports the minimum and the median over N runs plus the compiled
 * size of each agent bundle. Run it by hand; it is not part of the test suite
 * or of CI.
 *
 *   npm run build
 *   npm install --prefix tests/integration/app_loader/discovery
 *   node scripts/bench_agent_discovery.mjs [--dir <path>] [--runs <n>]
 *
 * The script imports the built loader from `dev/dist`, so `npm run build` must
 * run first, and the agents directory must already have its own dependencies
 * installed. The `unattributed` row is the end-to-end time minus the other
 * three, which are timed in passes of their own rather than inside
 * `listAgents()`. Expect it to be large and positive: the import pass runs
 * after the loader has already imported the same bundles, so V8 answers it
 * from a warm compilation cache. The last row measures that same import inside
 * the end-to-end call, and accounts for most of the difference. A strongly
 * negative residual means this script no longer models the loader, and the
 * numbers should not be trusted. Each run evaluates every bundle twice and
 * keeps both copies in memory, so a large `--runs` may need
 * `--max-old-space-size`.
 */

import {readdir, stat} from 'node:fs/promises';
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
const JS_FILE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts'];
const ENTRY_FILE_NAMES = ['app', 'agent'];
const PHASE_ROWS = [
  ['discovery scan', 'discoveryMs'],
  ['compile (esbuild, concurrent wall)', 'compileMs'],
  ['import (bundles, cache-busted re-import)', 'importMs'],
  ['end-to-end listAgents()', 'e2eMs'],
  ['unattributed (e2e - the three above)', 'unattributedMs'],
];
const LOADER_IMPORT_LABEL = 'loader import (inside e2e, after its last build)';
const LABEL_WIDTH = 50;
const NUMBER_WIDTH = 12;
const USAGE = `Usage: node scripts/bench_agent_discovery.mjs [options]

  --dir <path>   agents directory to measure
                 (default: ${DEFAULT_AGENTS_DIR})
  --runs <n>     timed runs, after ${WARMUP_RUNS} untimed warm-up run
                 (default: ${DEFAULT_RUNS})
  --help         print this message`;

const requireFromScript = createRequire(import.meta.url);

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

  if (values.help) {
    return {help: true};
  }

  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`--runs must be an integer >= 1, got '${values.runs}'.`);
  }

  return {dir: values.dir, runs, help: false};
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

function isJsFile(fileName) {
  return JS_FILE_EXTENSIONS.includes(path.extname(fileName));
}

async function readDirMetadata(dir) {
  const names = await readdir(dir);

  return Promise.all(
    names.map(async (name) => {
      const filePath = path.join(dir, name);
      const stats = await stat(filePath);
      return {
        path: filePath,
        name,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
      };
    }),
  );
}

/** Mirrors the `app.*` over `agent.*` preference of `AgentLoader`. */
function findEntryFile(files) {
  for (const entryName of ENTRY_FILE_NAMES) {
    const match = files.find(
      (file) =>
        file.isFile &&
        isJsFile(file.name) &&
        path.parse(file.name).name === entryName,
    );
    if (match) {
      return match;
    }
  }

  return undefined;
}

/**
 * Repeats the `readdir`/`stat` walk that `AgentLoader.preloadAgents()` performs
 * before it compiles anything, for the timing row and the discovered count.
 */
async function scanDiscovery(dir) {
  const entries = await readDirMetadata(dir);
  const subDirFiles = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory)
      .map((entry) => readDirMetadata(entry.path)),
  );

  const entryPoints = entries
    .filter((entry) => entry.isFile && isJsFile(entry.name))
    .map((entry) => entry.path);
  for (const files of subDirFiles) {
    const entryFile = findEntryFile(files);
    if (entryFile) {
      entryPoints.push(entryFile.path);
    }
  }

  return entryPoints;
}

/**
 * Mirrors `AgentLoader`, which names a top-level file after the file and a
 * nested entrypoint after its directory.
 */
function agentNameFor(entryPoint, agentsDir) {
  const parsed = path.parse(entryPoint);
  return path.resolve(parsed.dir) === agentsDir
    ? parsed.name
    : path.basename(parsed.dir);
}

/**
 * The loader deletes the bundle of a file that compiled but exported no agent,
 * so such a build reports nothing: it can be neither sized nor re-imported.
 */
async function bundleReport(build, agentsDir) {
  const stats = await statOrUndefined(build.outfile);
  return stats
    ? {
        name: agentNameFor(build.entryPoint, agentsDir),
        bytes: stats.size,
        outfile: build.outfile,
      }
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

/**
 * Re-evaluates the compiled bundles the way the loader does. Dropping the
 * `require` cache entry first is what makes this a measurement: a cache-busted
 * `import()` of a `.cjs` bundle otherwise resolves from the CommonJS cache and
 * reports near zero.
 */
async function timeImportPass(outfiles) {
  const start = performance.now();

  await Promise.all(
    outfiles.map(async (outfile) => {
      try {
        delete requireFromScript.cache[requireFromScript.resolve(outfile)];
      } catch {
        // The bundle is not in the CommonJS cache, so there is nothing to drop.
      }
      const cacheBuster = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await import(`${pathToFileURL(outfile).href}?t=${cacheBuster}`);
    }),
  );

  return performance.now() - start;
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

  const discoveryStart = performance.now();
  const entryPoints = await scanDiscovery(agentsDir);
  const discoveryMs = performance.now() - discoveryStart;

  const loader = new AgentLoader(agentsDir);
  try {
    const startedAt = performance.now();
    const loadedNames = await loader.listAgents();
    const endedAt = performance.now();

    // Checked before the probe: an empty directory also records no build, and
    // "nothing loaded" is the useful diagnosis there.
    assertEverythingLoaded(
      agentsDir,
      loadedNames,
      await loader.listLoadFailures(),
    );
    assertProbeAttached();

    const builds = [...recordedBuilds];
    const lastBuildEnd = Math.max(...builds.map((build) => build.end));
    const compileMs =
      lastBuildEnd - Math.min(...builds.map((build) => build.start));
    const bundles = (
      await Promise.all(builds.map((build) => bundleReport(build, agentsDir)))
    ).filter((bundle) => bundle !== undefined);
    const importMs = await timeImportPass(
      bundles.map((bundle) => bundle.outfile),
    );
    const e2eMs = endedAt - startedAt;

    return {
      discovered: entryPoints.length,
      loaded: loadedNames.length,
      bundles,
      sample: {
        discoveryMs,
        compileMs,
        importMs,
        e2eMs,
        unattributedMs: e2eMs - discoveryMs - compileMs - importMs,
        loaderImportMs: endedAt - lastBuildEnd,
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

function formatPhaseRow(label, results, key) {
  const values = results.map((result) => result.sample[key]);

  return formatRow(
    label,
    formatMs(Math.min(...values)),
    formatMs(median(values)),
  );
}

function printReport(agentsDir, timedRuns, results) {
  const last = results[results.length - 1];

  console.log('agent discovery benchmark');
  console.log(`  agents dir  : ${agentsDir}`);
  console.log(
    `  entrypoints : ${last.discovered} discovered, ${last.loaded} loaded`,
  );
  console.log(`  runs        : ${timedRuns} timed (${WARMUP_RUNS} warm-up)`);
  console.log(
    `  node        : ${process.version} ${process.platform}/${process.arch}, ${os.cpus().length} cpus`,
  );
  if (last.discovered !== last.loaded) {
    console.log(
      `  note        : the counts differ, so ${agentsDir} also holds files that export no agent.`,
    );
  }

  console.log('');
  console.log(formatRow('phase', 'min (ms)', 'median (ms)'));
  for (const [label, key] of PHASE_ROWS) {
    console.log(formatPhaseRow(label, results, key));
  }

  console.log('');
  console.log(
    '  unattributed is mostly the loader importing the same bundles,',
  );
  console.log('  which the warm re-import above cannot see:');
  console.log(formatPhaseRow(LOADER_IMPORT_LABEL, results, 'loaderImportMs'));

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
  // One of those listeners answers an uncaught exception with an argument-less
  // process.exit(), which reports success. Claim the exception first so that a
  // crash cannot be mistaken for a completed measurement.
  process.on('uncaughtException', (e) => {
    console.error(errorMessage(e));
    process.exit(1);
  });

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
