/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration coverage for the deploy folder `adk deploy cloud_run` stages.
 *
 * The existing deploy tests (`dev/test/cli/cli_deploy_cloud_run_test.ts`) mock
 * `node:fs/promises`, `node:child_process` and `AgentLoader`, so they can pass
 * while the staged folder is missing a file the generated `Dockerfile` copies
 * or while the compiled agent still has unresolved bare imports. This file
 * runs the real staging pipeline instead, in two layers:
 *
 * - **Layer 1 — staging consistency (always runs, no Docker).** Drives the
 *   unmocked `AgentLoader`, `copyAgentFiles`, `createPackageJson` and
 *   `createDockerFile` over a real fixture agent, then asserts the staged
 *   folder and the generated `Dockerfile` agree with each other.
 * - **Layer 2 — container smoke test (opt-in, Docker-gated).** Reuses the same
 *   staged folder to `docker build` and `docker run` the image, then asserts
 *   `GET /list-apps` answers with the staged app.
 *
 * Layer 2 is double-gated: it runs only when `ADK_RUN_DOCKER_DEPLOY_TEST=1`
 * **and** `docker info` succeeds. The environment variable is checked first so
 * that a default CI run never spawns `docker` at all — GitHub's
 * `ubuntu-latest` runner has a working daemon, so a daemon probe alone would
 * silently add a multi-minute image build to every pull request.
 *
 * `npm install && npm run build` must have been run at the repo root first:
 * esbuild resolves the fixture's `@google/adk` import through the root
 * `node_modules/@google/adk` workspace symlink, which points at `core/dist`.
 *
 * Running Layer 2 (bash):
 *
 * ```sh
 * ADK_RUN_DOCKER_DEPLOY_TEST=1 npx vitest run --project integration \
 *   tests/integration/deploy/cloud_run_deploy_test.ts
 * ```
 *
 * Running Layer 2 (PowerShell):
 *
 * ```powershell
 * $env:ADK_RUN_DOCKER_DEPLOY_TEST=1; npx vitest run --project integration `
 *   tests/integration/deploy/cloud_run_deploy_test.ts
 * ```
 */

import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  copyAgentFiles,
  createDockerFile,
  createPackageJson,
} from '../../../dev/src/cli/deploy/deploy_utils.js';
import {AgentLoader} from '../../../dev/src/utils/agent_loader.js';

const FIXTURE_DIR = path.join(
  process.cwd(),
  'tests/integration/deploy/fixture_agent',
);
/** The `appName` the Dockerfile is generated for, as `deployToCloudRun` derives it. */
const APP_NAME = path.basename(FIXTURE_DIR);
/**
 * The app `GET /list-apps` reports. `AgentLoader` keys agents by the basename
 * of the file it discovers, and what is staged into `agents/<appName>/` is the
 * compiled `agent.mjs`, so the served name is `agent`, not `<appName>`.
 */
const SERVED_APP_NAME = 'agent';
const CONTAINER_PORT = 8080;
const LOG_LEVEL = 'info';

/** A full `docker build` log comfortably exceeds execFile's 1 MB default. */
const DOCKER_MAX_BUFFER = 32 * 1024 * 1024;
const STAGING_TIMEOUT_MS = 120_000;
const DOCKER_TEST_TIMEOUT_MS = 900_000;
const READINESS_TIMEOUT_MS = 90_000;
const READINESS_POLL_INTERVAL_MS = 1_000;

/** Matches the `COPY --chown=<user> "<src>" "<dst>"` lines of the Dockerfile. */
const COPY_LINE_PATTERN = /^COPY\s+--chown=\S+\s+"([^"]+)"\s+"([^"]+)"$/gm;

const execFileAsync = promisify(execFile);

/** Renders a failure, including any output a failed child process produced. */
function formatFailure(error: unknown): string {
  const parts = [error instanceof Error ? error.message : String(error)];
  if (typeof error === 'object' && error !== null) {
    if ('stdout' in error && typeof error.stdout === 'string') {
      parts.push(`stdout:\n${error.stdout}`);
    }
    if ('stderr' in error && typeof error.stderr === 'string') {
      parts.push(`stderr:\n${error.stderr}`);
    }
  }
  return parts.join('\n');
}

/** Runs `docker` without a shell and returns its stdout. */
async function runDocker(args: string[]): Promise<string> {
  try {
    const {stdout} = await execFileAsync('docker', args, {
      maxBuffer: DOCKER_MAX_BUFFER,
    });
    return stdout;
  } catch (e: unknown) {
    throw new Error(
      `\`docker ${args.join(' ')}\` failed:\n${formatFailure(e)}`,
    );
  }
}

/** Whether a Docker daemon answers. Never throws: a missing binary and a
 * stopped daemon are both simply "no". */
async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], {maxBuffer: DOCKER_MAX_BUFFER});
    return true;
  } catch {
    return false;
  }
}

/** Extracts the host port from `docker port` output, e.g. `127.0.0.1:49154`. */
function parseHostPort(dockerPortOutput: string): number {
  const [firstLine] = dockerPortOutput.trim().split('\n');
  const hostPort = /:(\d+)$/.exec(firstLine ?? '');
  if (!hostPort) {
    expect.fail(`Cannot parse a host port from: ${dockerPortOutput}`);
  }
  return Number(hostPort[1]);
}

/**
 * Polls `GET /list-apps` until the container answers. Connection errors mean
 * "not up yet"; on deadline expiry the container logs are the diagnosis, so
 * they are included in the failure.
 */
async function waitForListApps(
  hostPort: number,
  containerName: string,
): Promise<unknown> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastFailure = 'the server never answered';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/list-apps`);
      if (response.ok) {
        return await response.json();
      }
      lastFailure = `HTTP ${response.status}: ${await response.text()}`;
    } catch (e: unknown) {
      lastFailure = formatFailure(e);
    }
    await sleep(READINESS_POLL_INTERVAL_MS);
  }
  const logs = await runDocker(['logs', containerName]).catch(formatFailure);
  expect.fail(
    `GET /list-apps did not answer within ${READINESS_TIMEOUT_MS}ms ` +
      `(${lastFailure}).\ndocker logs ${containerName}:\n${logs}`,
  );
}

/** Narrows a parsed JSON value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows a parsed `/list-apps` body to the documented `string[]` shape. */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string')
  );
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

const dockerRequested = process.env['ADK_RUN_DOCKER_DEPLOY_TEST'] === '1';
const dockerEnabled = dockerRequested && (await isDockerAvailable());

let agentLoader: AgentLoader | undefined;
let stagedDir: string;
let bundlePath: string;
let dockerfile: string;

beforeAll(async () => {
  // Mirrors deployToCloudRun, stopping short of the `gcloud run deploy` call.
  stagedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-deploy-test-'));
  agentLoader = new AgentLoader(FIXTURE_DIR);
  await copyAgentFiles(agentLoader, path.join(stagedDir, 'agents', APP_NAME));
  await createPackageJson(FIXTURE_DIR, stagedDir);
  await createDockerFile(stagedDir, {
    appName: APP_NAME,
    project: 'test-project',
    region: 'us-central1',
    port: CONTAINER_PORT,
    withUi: false,
    logLevel: LOG_LEVEL,
  });

  bundlePath = path.join(stagedDir, 'agents', APP_NAME, 'agent.mjs');
  dockerfile = await fs.readFile(path.join(stagedDir, 'Dockerfile'), 'utf8');
}, STAGING_TIMEOUT_MS);

afterAll(async () => {
  // Guarded independently: a staging failure must not skip the next step.
  await agentLoader?.disposeAll().catch(() => {});
  await fs.rm(stagedDir, {recursive: true, force: true}).catch(() => {});
}, STAGING_TIMEOUT_MS);

describe('Cloud Run deployment staging', () => {
  it('stages the compiled agent bundle under agents/<appName>', async () => {
    // `.mjs` is what the fixture manifest's `"type": "module"` buys.
    const stats = await fs.stat(bundlePath);
    expect(stats.isFile()).toBe(true);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('produces a self-contained bundle with no unresolved bare imports', async () => {
    const bundle = await fs.readFile(bundlePath, 'utf8');
    expect(bundle).not.toMatch(/from\s*["']@google\/adk["']/);
    expect(bundle).not.toMatch(/require\(\s*["']@google\/adk["']\s*\)/);
  });

  it('copies the fixture dependencies into the staged package.json', async () => {
    const fixtureManifest = await readJson(
      path.join(FIXTURE_DIR, 'package.json'),
    );
    const stagedManifest = await readJson(path.join(stagedDir, 'package.json'));
    if (!isRecord(fixtureManifest) || !isRecord(stagedManifest)) {
      expect.fail('Both package.json files must parse to objects');
    }
    expect(stagedManifest['dependencies']).toEqual(
      fixtureManifest['dependencies'],
    );
  });

  it('creates the package-lock.json and node_modules the Dockerfile expects', async () => {
    const lockStats = await fs.stat(path.join(stagedDir, 'package-lock.json'));
    expect(lockStats.isFile()).toBe(true);

    const nodeModulesStats = await fs.stat(
      path.join(stagedDir, 'node_modules'),
    );
    expect(nodeModulesStats.isDirectory()).toBe(true);
  });

  it('stages every file the generated Dockerfile copies', async () => {
    const copySources = [...dockerfile.matchAll(COPY_LINE_PATTERN)].map(
      (match) => match[1],
    );
    expect(copySources.length).toBeGreaterThan(0);

    for (const source of copySources) {
      // Dockerfile paths always use `/`; the staged folder uses the host
      // separator.
      const stagedPath = path.join(
        stagedDir,
        ...source.replace(/\/$/, '').split('/'),
      );
      const staged = await fs.stat(stagedPath).catch(() => undefined);
      expect(
        staged,
        `Dockerfile copies "${source}", which is not in the staged folder`,
      ).toBeDefined();
    }
  });

  it('points the container command at the staged app', () => {
    expect(dockerfile).toContain('FROM node:lts-alpine');
    expect(dockerfile).toContain('RUN npm install --production');
    expect(dockerfile).toContain(
      `CMD npx adk api_server /app/agents/${APP_NAME} ` +
        `--port=${CONTAINER_PORT} --host=0.0.0.0 --log_level=${LOG_LEVEL}`,
    );
  });
});

describe.skipIf(!dockerEnabled)('Cloud Run image smoke test', () => {
  const runId = randomUUID();
  const imageTag = `adk-deploy-test:${runId}`;
  const containerName = `adk-deploy-test-${runId}`;

  afterAll(async () => {
    await runDocker(['rm', '-f', containerName]).catch(() => {});
    await runDocker(['rmi', '-f', imageTag]).catch(() => {});
  }, DOCKER_TEST_TIMEOUT_MS);

  it(
    'builds an image that boots and serves the staged agent',
    async () => {
      await runDocker(['build', '-t', imageTag, stagedDir]);
      // Let Docker assign the host port so concurrent runs cannot race.
      await runDocker([
        'run',
        '-d',
        '--name',
        containerName,
        '-p',
        `127.0.0.1::${CONTAINER_PORT}`,
        imageTag,
      ]);
      const hostPort = parseHostPort(
        await runDocker(['port', containerName, `${CONTAINER_PORT}/tcp`]),
      );

      const apps = await waitForListApps(hostPort, containerName);
      expect(
        isStringArray(apps),
        `Unexpected /list-apps body: ${JSON.stringify(apps)}`,
      ).toBe(true);
      expect(apps).toEqual([SERVED_APP_NAME]);
    },
    DOCKER_TEST_TIMEOUT_MS,
  );
});
