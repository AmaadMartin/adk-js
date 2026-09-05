/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  getUserConfigPath,
  readTelemetryConsent,
} from '../../src/utils/telemetry_config.js';
import {CapturingLogger} from '../capturing_logger.js';

/**
 * `os.homedir()` reads `$HOME` on POSIX, so pointing it at a temp directory
 * gives each test its own config file without mocking the module.
 */
describe('telemetry config', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-telemetry-config-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    fs.rmSync(home, {recursive: true, force: true});
  });

  function writeConfig(contents: string): void {
    fs.mkdirSync(path.dirname(getUserConfigPath()), {recursive: true});
    fs.writeFileSync(getUserConfigPath(), contents, 'utf-8');
  }

  it('places the config file under .adk in the home directory', () => {
    expect(getUserConfigPath()).toBe(path.join(home, '.adk', 'config.json'));
  });

  it('reports an opt-in', () => {
    writeConfig('{"telemetry": true}');

    expect(readTelemetryConsent(new CapturingLogger())).toBe(true);
  });

  it('reports an opt-out', () => {
    writeConfig('{"telemetry": false}');

    expect(readTelemetryConsent(new CapturingLogger())).toBe(false);
  });

  it('reports no preference when the config file is absent', () => {
    const logger = new CapturingLogger();

    expect(readTelemetryConsent(logger)).toBeUndefined();
    expect(logger.warnMessages).toEqual([]);
  });

  it('reports no preference when the config records no telemetry key', () => {
    writeConfig('{"other": 1}');

    expect(readTelemetryConsent(new CapturingLogger())).toBeUndefined();
  });

  it('reports no preference when the recorded value is not a boolean', () => {
    writeConfig('{"telemetry": "yes"}');

    expect(readTelemetryConsent(new CapturingLogger())).toBeUndefined();
  });

  it('reports no preference when the config is not an object', () => {
    writeConfig('[1, 2]');

    expect(readTelemetryConsent(new CapturingLogger())).toBeUndefined();
  });

  it('warns and reports no preference when the config is malformed', () => {
    writeConfig('{not json');
    const logger = new CapturingLogger();

    expect(readTelemetryConsent(logger)).toBeUndefined();
    expect(logger.warnMessages).toHaveLength(1);
    expect(logger.warnMessages[0]).toContain(
      'Failed to read telemetry config from',
    );
  });
});
