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
 * installed. The import pass runs after the loader has imported the same
 * bundles, so V8 answers it from a warm compilation cache and it reads lower
 * than the `loader import` row, which is the same work measured inside
 * `listAgents()`. Each run evaluates every bundle twice and keeps both copies
 * in memory, so a large `--runs` may need `--max-old-space-size`.
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
const PHASE_ROWS = [
  ['discovery scan', 'discoveryMs'],
  ['compile (esbuild, concurrent wall)', 'compileMs'],
  ['import (bundles, cache-busted re-import)', 'importMs'],
  ['loader import (inside e2e, after its last build)', 'loaderImportMs'],
  ['end-to-end listAgents()', 'e2eMs'],
  ['unattributed (e2e - discovery - compile - import)', 'unattributedMs'],
];
const USAGE = `Usage: node scripts/bench_agent_discovery.mjs [options]

  --dir <path>   agents directory to measure
                 (default: ${DEFAULT_AGENTS_DIR})
  --runs <n>     timed runs, after 1 untimed warm-up run
                 (default: ${DEFAULT_RUNS})
  --help         print this message

Run 'npm run build' first, and install the agents directory's own
dependencies with 'npm install --prefix <dir>'.`;

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

/**
 * Repeats the `readdir`/`stat` walk that `AgentLoader.preloadAgents()` performs
 * over the agents directory and each of its subdirectories. Run it after the
 * timed call, so that it cannot warm the directory cache for it.
 */
async function timeDiscoveryScan(dir) {
  const start = performance.now();

  const names = await readdir(dir);
  const entries = await Promise.all(
    names.map(async (name) => ({
      path: path.join(dir, name),
      stats: await stat(path.join(dir, name)),
    })),
  );
  await Promise.all(
    entries
      .filter((entry) => entry.stats.isDirectory())
      .map(async (entry) => {
        const subNames = await readdir(entry.path);
        await Promise.all(
          subNames.map((name) => stat(path.join(entry.path, name))),
        );
      }),
  );

  return performance.now() - start;
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
    const discoveryMs = await timeDiscoveryScan(agentsDir);
    const e2eMs = endedAt - startedAt;

    return {
      compiled: builds.length,
      loaded: loadedNames.length,
      bundles,
      sample: {
        discoveryMs,
        compileMs,
        importMs,
        loaderImportMs: endedAt - lastBuildEnd,
        e2eMs,
        unattributedMs: e2eMs - discoveryMs - compileMs - importMs,
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

function phaseStats(results, key) {
  const values = results.map((result) => result.sample[key]);

  return {
    'min (ms)': Number(Math.min(...values).toFixed(1)),
    'median (ms)': Number(median(values).toFixed(1)),
  };
}

function printReport(agentsDir, timedRuns, results) {
  const last = results[results.length - 1];

  console.log('agent discovery benchmark');
  console.log(`  agents dir  : ${agentsDir}`);
  console.log(
    `  entrypoints : ${last.compiled} compiled, ${last.loaded} loaded`,
  );
  console.log(`  runs        : ${timedRuns} timed (1 warm-up)`);
  console.log(
    `  node        : ${process.version} ${process.platform}/${process.arch}, ${os.cpus().length} cpus`,
  );
  if (last.compiled !== last.loaded) {
    console.log(
      `  note        : the counts differ, so ${agentsDir} also holds files that export no agent.`,
    );
  }

  console.table(
    Object.fromEntries(
      PHASE_ROWS.map(([label, key]) => [label, phaseStats(results, key)]),
    ),
  );
  console.table(
    Object.fromEntries(
      [...last.bundles]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((bundle) => [
          bundle.name,
          {'size (MiB)': Number((bundle.bytes / 1024 / 1024).toFixed(2))},
        ]),
    ),
  );
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

    // The first run pays for starting the esbuild service, so it is untimed.
    await runOnce(agentsDir, AgentLoader);

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
