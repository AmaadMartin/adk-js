/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  getUserConfigPath,
  readTelemetryConsent,
} from '../../src/utils/telemetry_config.js';
import {CapturingLogger} from '../capturing_logger.js';
import {setHomeDir} from '../temp_home.js';

describe('readTelemetryConsent', () => {
  let homeDir: string;
  let logger: CapturingLogger;
  let restoreHomeDir: () => void;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-home-'));
    logger = new CapturingLogger();
    restoreHomeDir = setHomeDir(homeDir);
  });

  afterEach(async () => {
    restoreHomeDir();
    await fs.rm(homeDir, {recursive: true, force: true});
  });

  async function writeUserConfig(contents: string): Promise<void> {
    await fs.mkdir(path.join(homeDir, '.adk'), {recursive: true});
    await fs.writeFile(getUserConfigPath(), contents, 'utf-8');
  }

  it('resolves the config path under the home directory', () => {
    expect(getUserConfigPath()).toBe(path.join(homeDir, '.adk', 'config.json'));
  });

  it('reports no preference when the config file is missing', async () => {
    expect(await readTelemetryConsent(logger)).toBeNull();
    expect(logger.warnMessages).toEqual([]);
  });

  it('reports an opt-in', async () => {
    await writeUserConfig(JSON.stringify({telemetry: true}));

    expect(await readTelemetryConsent(logger)).toBe(true);
  });

  it('reports an opt-out', async () => {
    await writeUserConfig(JSON.stringify({telemetry: false}));

    expect(await readTelemetryConsent(logger)).toBe(false);
  });

  it('reports no preference when the recorded value is not a boolean', async () => {
    await writeUserConfig(JSON.stringify({telemetry: 'yes'}));

    expect(await readTelemetryConsent(logger)).toBeNull();
    expect(logger.warnMessages).toEqual([]);
  });

  it('reports no preference when the config holds no telemetry key', async () => {
    await writeUserConfig(JSON.stringify({other: 1}));

    expect(await readTelemetryConsent(logger)).toBeNull();
  });

  it('reports no preference when the config is not an object', async () => {
    await writeUserConfig('"just a string"');

    expect(await readTelemetryConsent(logger)).toBeNull();
  });

  it('warns and reports no preference when the config is malformed', async () => {
    await writeUserConfig('{not json');

    expect(await readTelemetryConsent(logger)).toBeNull();
    expect(logger.warnMessages.join('\n')).toContain(
      'Failed to read telemetry config from',
    );
  });

  it('warns and reports no preference when the config cannot be read', async () => {
    // A directory where the config file belongs: the read fails with EISDIR.
    await fs.mkdir(getUserConfigPath(), {recursive: true});

    expect(await readTelemetryConsent(logger)).toBeNull();
    expect(logger.warnMessages.join('\n')).toContain(
      'Failed to read telemetry config from',
    );
  });
});
