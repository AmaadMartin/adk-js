/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const DISABLE_FLAG = 'ADK_DISABLE_LOAD_DOTENV';
const FROM_FILE = 'ADK_TEST_ENVS_FROM_FILE';
const EXPLICIT = 'ADK_TEST_ENVS_EXPLICIT';

/** A filename no ancestor of the temp directory can supply. */
const ABSENT_FILENAME = '.env.adk-test-absent';

/**
 * Hook budget (ms) for the one-off import that warms the module graph. The
 * first transform of the module under test exceeds the default test budget on
 * a loaded machine; every later import re-executes cached code instead.
 */
const WARMUP_HOOK_TIMEOUT_MS = 60000;

/**
 * Imports a fresh copy of the module under test, so its snapshot of the
 * explicit environment reflects whatever the test exported first.
 */
async function loadEnvs() {
  vi.resetModules();
  const {AdkLogger} = await import('../../src/utils/logger.js');
  const warn = vi.spyOn(AdkLogger.prototype, 'warn').mockImplementation(() => {
    // The logger writes to the console; the assertions read the spy instead.
  });
  const debug = vi
    .spyOn(AdkLogger.prototype, 'debug')
    .mockImplementation(() => {});
  const {loadDotenvForAgent} = await import('../../src/utils/envs.js');

  return {loadDotenvForAgent, warn, debug};
}

describe('loadDotenvForAgent', () => {
  let originalEnv: typeof process.env;
  let parentDir: string;
  let agentDir: string;

  beforeAll(async () => {
    await import('../../src/utils/envs.js');
  }, WARMUP_HOOK_TIMEOUT_MS);

  beforeEach(() => {
    originalEnv = {...process.env};
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-envs-'));
    agentDir = path.join(parentDir, 'weather');
    fs.mkdirSync(agentDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('dotenv');
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(parentDir, {recursive: true, force: true});
  });

  it("loads the .env in the agent's own directory", async () => {
    fs.writeFileSync(path.join(agentDir, '.env'), `${FROM_FILE}=from-agent\n`);
    const {loadDotenvForAgent} = await loadEnvs();

    loadDotenvForAgent('weather', parentDir);

    expect(process.env[FROM_FILE]).toBe('from-agent');
  });

  it('walks up to the parent directory when the agent has no .env', async () => {
    fs.writeFileSync(
      path.join(parentDir, '.env'),
      `${FROM_FILE}=from-parent\n`,
    );
    const {loadDotenvForAgent} = await loadEnvs();

    loadDotenvForAgent('weather', parentDir);

    expect(process.env[FROM_FILE]).toBe('from-parent');
  });

  it('prefers the nearest .env over one further up the tree', async () => {
    fs.writeFileSync(
      path.join(parentDir, '.env'),
      `${FROM_FILE}=from-parent\n`,
    );
    fs.writeFileSync(path.join(agentDir, '.env'), `${FROM_FILE}=from-agent\n`);
    const {loadDotenvForAgent} = await loadEnvs();

    loadDotenvForAgent('weather', parentDir);

    expect(process.env[FROM_FILE]).toBe('from-agent');
  });

  it('stops at the filesystem root when no file exists', async () => {
    const {loadDotenvForAgent, debug} = await loadEnvs();

    loadDotenvForAgent('weather', parentDir, ABSENT_FILENAME);

    expect(process.env[FROM_FILE]).toBeUndefined();
    expect(debug.mock.calls.flat().join(' ')).toContain(
      `No ${ABSENT_FILENAME} file found for weather`,
    );
  });

  it('starts below the parent when the agent directory does not exist', async () => {
    // The single-file layout, `agents/weather.ts`: `<parent>/weather` is not a
    // directory, so the walk begins one level up.
    fs.writeFileSync(
      path.join(parentDir, '.env'),
      `${FROM_FILE}=from-parent\n`,
    );
    const {loadDotenvForAgent} = await loadEnvs();

    loadDotenvForAgent('nowhere', parentDir);

    expect(process.env[FROM_FILE]).toBe('from-parent');
  });

  it.each(['1', 'true', 'TRUE'])(
    'reads no file when %s disables the load',
    async (value) => {
      fs.writeFileSync(
        path.join(agentDir, '.env'),
        `${FROM_FILE}=from-agent\n`,
      );
      process.env[DISABLE_FLAG] = value;
      const {loadDotenvForAgent} = await loadEnvs();

      loadDotenvForAgent('weather', parentDir);

      expect(process.env[FROM_FILE]).toBeUndefined();
    },
  );

  it('still loads the file when the disable flag holds another value', async () => {
    fs.writeFileSync(path.join(agentDir, '.env'), `${FROM_FILE}=from-agent\n`);
    process.env[DISABLE_FLAG] = 'no';
    const {loadDotenvForAgent} = await loadEnvs();

    loadDotenvForAgent('weather', parentDir);

    expect(process.env[FROM_FILE]).toBe('from-agent');
  });

  it('keeps a variable the user exported before the process started', async () => {
    process.env[EXPLICIT] = 'from-shell';
    fs.writeFileSync(
      path.join(agentDir, '.env'),
      `${EXPLICIT}=from-file\n${FROM_FILE}=from-agent\n`,
    );
    const {loadDotenvForAgent} = await loadEnvs();

    loadDotenvForAgent('weather', parentDir);

    expect(process.env[EXPLICIT]).toBe('from-shell');
    expect(process.env[FROM_FILE]).toBe('from-agent');
  });

  it('lets a later .env override what an earlier .env set', async () => {
    process.env[EXPLICIT] = 'from-shell';
    const secondAgentDir = path.join(parentDir, 'traffic');
    fs.mkdirSync(secondAgentDir);
    fs.writeFileSync(
      path.join(agentDir, '.env'),
      `${EXPLICIT}=from-first\n${FROM_FILE}=from-first\n`,
    );
    fs.writeFileSync(
      path.join(secondAgentDir, '.env'),
      `${EXPLICIT}=from-second\n${FROM_FILE}=from-second\n`,
    );
    const {loadDotenvForAgent} = await loadEnvs();

    loadDotenvForAgent('weather', parentDir);
    loadDotenvForAgent('traffic', parentDir);

    expect(process.env[FROM_FILE]).toBe('from-second');
    expect(process.env[EXPLICIT]).toBe('from-shell');
  });

  it('honours a custom filename', async () => {
    fs.writeFileSync(
      path.join(agentDir, '.env.staging'),
      `${FROM_FILE}=from-staging\n`,
    );
    const {loadDotenvForAgent} = await loadEnvs();

    loadDotenvForAgent('weather', parentDir, '.env.staging');

    expect(process.env[FROM_FILE]).toBe('from-staging');
  });

  it('skips a malformed line and keeps the rest of the file', async () => {
    fs.writeFileSync(
      path.join(agentDir, '.env'),
      `not a variable at all\n${FROM_FILE}=from-agent\n`,
    );
    const {loadDotenvForAgent} = await loadEnvs();

    expect(() => loadDotenvForAgent('weather', parentDir)).not.toThrow();
    expect(process.env[FROM_FILE]).toBe('from-agent');
  });

  it('warns with the path and continues when the file cannot be read', async () => {
    process.env[EXPLICIT] = 'from-shell';
    const dotenvPath = path.join(agentDir, '.env');
    fs.writeFileSync(dotenvPath, `${EXPLICIT}=from-file\n`);
    // dotenv reports a read failure rather than throwing, and there is no
    // portable way to make a real file unreadable in a test.
    vi.doMock('dotenv', () => ({
      default: {
        config: () => ({error: new Error('EACCES: permission denied')}),
      },
    }));
    const {loadDotenvForAgent, warn} = await loadEnvs();

    expect(() => loadDotenvForAgent('weather', parentDir)).not.toThrow();

    const warned = warn.mock.calls.flat().join(' ');
    expect(warned).toContain(dotenvPath);
    expect(warned).toContain('EACCES: permission denied');
    expect(warned).not.toContain('from-file');
    expect(process.env[EXPLICIT]).toBe('from-shell');
  });

  it('restores the explicit environment when the loader throws', async () => {
    process.env[EXPLICIT] = 'from-shell';
    fs.writeFileSync(path.join(agentDir, '.env'), `${EXPLICIT}=from-file\n`);
    vi.doMock('dotenv', () => ({
      default: {
        config: () => {
          process.env[EXPLICIT] = 'from-file';
          throw new Error('dotenv exploded');
        },
      },
    }));
    const {loadDotenvForAgent, warn} = await loadEnvs();

    expect(() => loadDotenvForAgent('weather', parentDir)).not.toThrow();

    expect(warn.mock.calls.flat().join(' ')).toContain('dotenv exploded');
    expect(process.env[EXPLICIT]).toBe('from-shell');
  });

  it('warns when the loader rejects with something other than an Error', async () => {
    fs.writeFileSync(path.join(agentDir, '.env'), `${FROM_FILE}=from-agent\n`);
    vi.doMock('dotenv', () => ({
      default: {
        config: () => {
          throw 'plain string failure';
        },
      },
    }));
    const {loadDotenvForAgent, warn} = await loadEnvs();

    expect(() => loadDotenvForAgent('weather', parentDir)).not.toThrow();

    expect(warn.mock.calls.flat().join(' ')).toContain('plain string failure');
  });

  it('does not restore a variable the caller deleted after the snapshot', async () => {
    process.env[EXPLICIT] = 'from-shell';
    fs.writeFileSync(path.join(agentDir, '.env'), `${FROM_FILE}=from-agent\n`);
    const {loadDotenvForAgent} = await loadEnvs();
    delete process.env[EXPLICIT];

    loadDotenvForAgent('weather', parentDir);

    expect(process.env[EXPLICIT]).toBeUndefined();
  });
});
