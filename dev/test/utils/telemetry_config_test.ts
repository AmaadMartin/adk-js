/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  getUserConfigPath,
  readTelemetryConsent,
} from '../../src/utils/telemetry_config.js';
import {CapturingLogger} from '../capturing_logger.js';
import {TempHome} from '../temp_home.js';

describe('telemetry config', () => {
  const tempHome = new TempHome();
  let home: string;

  beforeEach(() => {
    home = tempHome.create();
  });

  afterEach(() => {
    tempHome.remove();
  });

  function writeConfig(contents: string): void {
    tempHome.writeAdkConfig(contents);
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
