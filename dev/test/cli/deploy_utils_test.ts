/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';
import {
  formatGcloudEnvVarsArg,
  loadAgentEnvConfig,
} from '../../src/cli/deploy/deploy_utils.js';

describe('loadAgentEnvConfig', () => {
  let agentDir: string;
  let infoSpy: MockInstance<typeof console.info>;
  let warnSpy: MockInstance<typeof console.warn>;

  /** Writes `.env` into the temp agent directory and returns its path. */
  async function writeEnvFile(contents: string): Promise<string> {
    const envFile = path.join(agentDir, '.env');
    await fs.writeFile(envFile, contents, {encoding: 'utf-8'});
    return envFile;
  }

  /** All arguments passed to the console.info/console.warn spies. */
  function loggedArguments(): unknown[] {
    return [...infoSpy.mock.calls, ...warnSpy.mock.calls].flat();
  }

  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-env-config-'));
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(agentDir, {recursive: true, force: true});
  });

  it('should contribute nothing and stay silent when there is no .env', async () => {
    const config = await loadAgentEnvConfig(agentDir, {
      project: 'flag-project',
      region: 'flag-region',
    });

    expect(config).toEqual({envVars: {}});
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('should return every variable in file order', async () => {
    const envFile = await writeEnvFile('B=2\nA=1\nC=3\n');

    const config = await loadAgentEnvConfig(agentDir, {});

    expect(Object.entries(config.envVars)).toEqual([
      ['B', '2'],
      ['A', '1'],
      ['C', '3'],
    ]);
    expect(infoSpy).toHaveBeenCalledWith(
      `Reading environment variables from ${envFile}`,
    );
    expect(infoSpy).toHaveBeenCalledWith(
      `Forwarding 3 environment variable(s) from ${envFile}: B, A, C`,
    );
  });

  it('should resolve project and region from .env and not forward them', async () => {
    const envFile = await writeEnvFile(
      'GOOGLE_CLOUD_PROJECT=env-project\nGOOGLE_CLOUD_LOCATION=env-region\n',
    );

    const config = await loadAgentEnvConfig(agentDir, {});

    expect(config).toEqual({
      envVars: {},
      project: 'env-project',
      region: 'env-region',
    });
    expect(infoSpy).toHaveBeenCalledWith(
      `project='env-project' set by GOOGLE_CLOUD_PROJECT in ${envFile}`,
    );
    expect(infoSpy).toHaveBeenCalledWith(
      `region='env-region' set by GOOGLE_CLOUD_LOCATION in ${envFile}`,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should keep the CLI flags and warn when .env also sets project and region', async () => {
    await writeEnvFile(
      'GOOGLE_CLOUD_PROJECT=env-project\nGOOGLE_CLOUD_LOCATION=env-region\n',
    );

    const config = await loadAgentEnvConfig(agentDir, {
      project: 'flag-project',
      region: 'flag-region',
    });

    expect(config).toEqual({
      envVars: {},
      project: undefined,
      region: undefined,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Ignoring GOOGLE_CLOUD_PROJECT in .env as `--project` was explicitly passed and takes precedence',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Ignoring GOOGLE_CLOUD_LOCATION in .env as `--region` was explicitly passed and takes precedence',
    );
  });

  it('should ignore an empty GOOGLE_CLOUD_PROJECT without warning', async () => {
    await writeEnvFile('GOOGLE_CLOUD_PROJECT=\nA=1\n');

    const config = await loadAgentEnvConfig(agentDir, {});

    expect(config.project).toBeUndefined();
    expect(config.envVars).toEqual({A: '1'});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should ignore an empty GOOGLE_CLOUD_LOCATION without warning', async () => {
    await writeEnvFile('GOOGLE_CLOUD_LOCATION=\nA=1\n');

    const config = await loadAgentEnvConfig(agentDir, {});

    expect(config.region).toBeUndefined();
    expect(config.envVars).toEqual({A: '1'});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should parse quoted values, comments and blank lines', async () => {
    await writeEnvFile(
      '# a comment\n\nQUOTED="hello world"\nSINGLE=\'single\'\nPLAIN=plain # trailing\n',
    );

    const config = await loadAgentEnvConfig(agentDir, {});

    expect(config.envVars).toEqual({
      QUOTED: 'hello world',
      SINGLE: 'single',
      PLAIN: 'plain',
    });
  });

  it('should never log a variable value', async () => {
    await writeEnvFile(
      'GOOGLE_API_KEY=super-secret\nGOOGLE_CLOUD_PROJECT=env-project\n',
    );

    const config = await loadAgentEnvConfig(agentDir, {});

    expect(config.envVars).toEqual({GOOGLE_API_KEY: 'super-secret'});
    for (const logged of loggedArguments()) {
      expect(String(logged)).not.toContain('super-secret');
    }
  });

  it('should not mutate process.env', async () => {
    await writeEnvFile('ADK_DEPLOY_ENV_PROBE=probe-value\n');
    const before = {...process.env};

    await loadAgentEnvConfig(agentDir, {});

    expect(process.env).toEqual(before);
    expect(process.env['ADK_DEPLOY_ENV_PROBE']).toBeUndefined();
  });
});

describe('formatGcloudEnvVarsArg', () => {
  it('should format a single entry without a delimiter prefix', () => {
    expect(formatGcloudEnvVarsArg({ADK_A2A_AUTH_TOKEN: 'token'})).toBe(
      'ADK_A2A_AUTH_TOKEN=token',
    );
  });

  it('should join comma-free entries with a comma', () => {
    expect(formatGcloudEnvVarsArg({A: '1', B: '2'})).toBe('A=1,B=2');
  });

  it('should switch to an alternative delimiter when a value contains a comma', () => {
    expect(formatGcloudEnvVarsArg({A: '1,2', B: '3'})).toBe('^@^A=1,2@B=3');
  });

  it('should grow the delimiter until it is absent from the payload', () => {
    expect(formatGcloudEnvVarsArg({A: '1,2', B: 'a@b'})).toBe(
      '^@@^A=1,2@@B=a@b',
    );
  });

  it('should escape a value containing every punctuation character', () => {
    expect(formatGcloudEnvVarsArg({A: ',@|;#^', B: 'plain'})).toBe(
      '^@@^A=,@|;#^@@B=plain',
    );
  });

  it('should format an empty map as an empty string', () => {
    expect(formatGcloudEnvVarsArg({})).toBe('');
  });
});
