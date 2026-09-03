/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {readTelemetryConsent} from '../../../src/cli/telemetry/consent.js';

describe('readTelemetryConsent', () => {
  let home: string;
  let configFile: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-consent-'));
    configFile = path.join(home, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('returns undefined when the config file is missing', () => {
    expect(readTelemetryConsent(configFile)).toBeUndefined();
  });

  it('returns true when the user opted in', () => {
    fs.writeFileSync(configFile, JSON.stringify({telemetry: true}));

    expect(readTelemetryConsent(configFile)).toBe(true);
  });

  it('returns false when the user opted out', () => {
    fs.writeFileSync(configFile, JSON.stringify({telemetry: false}));

    expect(readTelemetryConsent(configFile)).toBe(false);
  });

  it('returns undefined when the recorded value is not a boolean', () => {
    fs.writeFileSync(configFile, JSON.stringify({telemetry: 'yes'}));

    expect(readTelemetryConsent(configFile)).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    fs.writeFileSync(configFile, '{telemetry: true');

    expect(readTelemetryConsent(configFile)).toBeUndefined();
  });

  it('returns undefined when the JSON root is an array', () => {
    fs.writeFileSync(configFile, JSON.stringify([{telemetry: true}]));

    expect(readTelemetryConsent(configFile)).toBeUndefined();
  });
});
