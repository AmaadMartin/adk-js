/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  getUserConfigPath,
  readTelemetryConsent,
  writeTelemetryConsent,
} from '../../src/utils/telemetry_config.js';

const {fakeHome} = vi.hoisted(() => ({fakeHome: {path: ''}}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {...actual, homedir: () => fakeHome.path};
});

describe('telemetry_config', () => {
  let configPath: string;

  beforeEach(() => {
    fakeHome.path = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-telemetry-'));
    configPath = path.join(fakeHome.path, '.adk', 'config.json');
  });

  afterEach(() => {
    fs.rmSync(fakeHome.path, {recursive: true, force: true});
  });

  const writeConfigFile = (contents: string) => {
    fs.mkdirSync(path.dirname(configPath), {recursive: true});
    fs.writeFileSync(configPath, contents, 'utf-8');
  };

  describe('getUserConfigPath', () => {
    it('points at .adk/config.json under the home directory', () => {
      expect(getUserConfigPath()).toBe(configPath);
    });
  });

  describe('readTelemetryConsent', () => {
    it('returns undefined when the config file is absent', () => {
      expect(readTelemetryConsent()).toBeUndefined();
    });

    it('returns undefined for malformed JSON without throwing', () => {
      writeConfigFile('{not json');

      expect(readTelemetryConsent()).toBeUndefined();
    });

    it('returns undefined when the config is not an object', () => {
      writeConfigFile('[1, 2]');

      expect(readTelemetryConsent()).toBeUndefined();
    });

    it('returns undefined when telemetry is not a boolean', () => {
      writeConfigFile('{"telemetry": "yes"}');

      expect(readTelemetryConsent()).toBeUndefined();
    });

    it.each([true, false])('returns the recorded value %s', (recorded) => {
      writeConfigFile(`{"telemetry": ${recorded}}`);

      expect(readTelemetryConsent()).toBe(recorded);
    });
  });

  describe('writeTelemetryConsent', () => {
    it.each([true, false])('round-trips %s', (enabled) => {
      writeTelemetryConsent(enabled);

      expect(readTelemetryConsent()).toBe(enabled);
    });

    it('creates the parent directory and ends the file with a newline', () => {
      writeTelemetryConsent(true);

      expect(fs.readFileSync(configPath, 'utf-8')).toBe(
        '{\n  "telemetry": true\n}\n',
      );
    });

    it('preserves unrelated keys', () => {
      writeConfigFile('{"theme": "dark"}');

      writeTelemetryConsent(true);

      expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({
        theme: 'dark',
        telemetry: true,
      });
    });

    it.each([
      ['a non-object file', '"just a string"'],
      ['malformed JSON', '{not json'],
    ])('starts from an empty config over %s', (_name, contents) => {
      writeConfigFile(contents);

      writeTelemetryConsent(false);

      expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({
        telemetry: false,
      });
    });

    it('rethrows when the config cannot be written', () => {
      // A regular file where the .adk directory belongs, so mkdir fails.
      fs.writeFileSync(path.join(fakeHome.path, '.adk'), 'blocked', 'utf-8');

      expect(() => writeTelemetryConsent(true)).toThrow();
    });
  });
});
