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
import {warnOnApiKeyPrecedence} from '../../src/cli/deploy/deploy_utils.js';

const CLI_API_KEY = 'test-api-key';
const DOTENV_API_KEY = 'dotenv-api-key';
const PRECEDENCE_WARNING =
  'Ignoring GOOGLE_API_KEY in .env as `--api_key` was explicitly passed and takes precedence';

describe('warnOnApiKeyPrecedence', () => {
  let agentDir: string;
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-deploy-utils-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(agentDir, {recursive: true, force: true});
  });

  const writeEnvFile = (contents: string) =>
    fs.writeFile(path.join(agentDir, '.env'), contents);

  it('should not warn when no api key was passed on the command line', async () => {
    await writeEnvFile(`GOOGLE_API_KEY=${DOTENV_API_KEY}\n`);

    await warnOnApiKeyPrecedence(agentDir, undefined);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should not warn when the agent folder has no .env file', async () => {
    await warnOnApiKeyPrecedence(agentDir, CLI_API_KEY);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should not warn when .env does not define GOOGLE_API_KEY', async () => {
    await writeEnvFile('GOOGLE_CLOUD_PROJECT=test-project\n');

    await warnOnApiKeyPrecedence(agentDir, CLI_API_KEY);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('should warn exactly once when .env also defines GOOGLE_API_KEY', async () => {
    await writeEnvFile(`GOOGLE_API_KEY=${DOTENV_API_KEY}\n`);

    await warnOnApiKeyPrecedence(agentDir, CLI_API_KEY);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(PRECEDENCE_WARNING),
    );
  });

  it('should never include an api key value in the warning', async () => {
    await writeEnvFile(`GOOGLE_API_KEY=${DOTENV_API_KEY}\n`);

    await warnOnApiKeyPrecedence(agentDir, CLI_API_KEY);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.not.stringContaining(CLI_API_KEY),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.not.stringContaining(DOTENV_API_KEY),
    );
  });
});
