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
  INCOMPLETE_LOGO_CONFIG_MESSAGE,
  resolveLogoConfig,
  writeRuntimeConfig,
} from '../../src/server/runtime_config.js';
import {CapturingLogger} from './capturing_logger.js';

describe('resolveLogoConfig', () => {
  it('returns undefined when neither option is set', () => {
    expect(resolveLogoConfig(undefined, undefined)).toBeUndefined();
    expect(resolveLogoConfig('', '')).toBeUndefined();
  });

  it('returns both values when both are set', () => {
    expect(resolveLogoConfig('Acme', 'https://acme.example/logo.png')).toEqual({
      text: 'Acme',
      imageUrl: 'https://acme.example/logo.png',
    });
  });

  it('rejects a logo with only the text set', () => {
    expect(() => resolveLogoConfig('Acme', undefined)).toThrow(
      INCOMPLETE_LOGO_CONFIG_MESSAGE,
    );
  });

  it('rejects a logo with only the image url set', () => {
    expect(() =>
      resolveLogoConfig(undefined, 'https://acme.example/logo.png'),
    ).toThrow(INCOMPLETE_LOGO_CONFIG_MESSAGE);
  });
});

describe('writeRuntimeConfig', () => {
  let webAssetsDir: string;
  let configPath: string;
  let logger: CapturingLogger;

  beforeEach(() => {
    webAssetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-web-assets-'));
    configPath = path.join(
      webAssetsDir,
      'assets',
      'config',
      'runtime-config.json',
    );
    logger = new CapturingLogger();
  });

  afterEach(() => {
    fs.rmSync(webAssetsDir, {recursive: true, force: true});
  });

  function writeExistingConfig(contents: string): void {
    fs.mkdirSync(path.dirname(configPath), {recursive: true});
    fs.writeFileSync(configPath, contents);
  }

  function readWrittenConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }

  it('creates the config when the assets directory holds none', () => {
    writeRuntimeConfig({webAssetsDir, backendUrl: '/adk', logger});

    expect(readWrittenConfig()).toEqual({backendUrl: '/adk'});
    expect(logger.infos.join('\n')).toContain('File not found');
  });

  it('records the telemetry consent it is given', () => {
    writeRuntimeConfig({
      webAssetsDir,
      backendUrl: '',
      telemetry: false,
      logger,
    });

    expect(readWrittenConfig()).toEqual({backendUrl: '', telemetry: false});
  });

  it('omits telemetry when no consent was recorded', () => {
    writeRuntimeConfig({webAssetsDir, backendUrl: '', logger});

    expect('telemetry' in readWrittenConfig()).toBe(false);
  });

  it('keeps the keys the shipped config already holds', () => {
    writeExistingConfig('{"featureFlag": true, "backendUrl": "/old"}');

    writeRuntimeConfig({webAssetsDir, backendUrl: '/new', logger});

    expect(readWrittenConfig()).toEqual({
      featureFlag: true,
      backendUrl: '/new',
    });
  });

  it('overwrites a config that is not valid JSON, and reports it', () => {
    writeExistingConfig('{not json');

    writeRuntimeConfig({webAssetsDir, backendUrl: '', logger});

    expect(readWrittenConfig()).toEqual({backendUrl: ''});
    expect(logger.warnings.join('\n')).toContain('will be overwritten');
  });

  it('overwrites a config that is not a JSON object, and reports it', () => {
    writeExistingConfig('["not", "an", "object"]');

    writeRuntimeConfig({webAssetsDir, backendUrl: '', logger});

    expect(readWrittenConfig()).toEqual({backendUrl: ''});
    expect(logger.warnings.join('\n')).toContain('does not hold a JSON object');
  });

  it('writes the logo when one is configured', () => {
    writeRuntimeConfig({
      webAssetsDir,
      backendUrl: '',
      logo: {text: 'Acme', imageUrl: 'https://acme.example/logo.png'},
      logger,
    });

    expect(readWrittenConfig()['logo']).toEqual({
      text: 'Acme',
      imageUrl: 'https://acme.example/logo.png',
    });
  });

  it('deletes a logo the shipped config holds when none is configured', () => {
    writeExistingConfig('{"logo": {"text": "Old", "imageUrl": "old.png"}}');

    writeRuntimeConfig({webAssetsDir, backendUrl: '', logger});

    expect('logo' in readWrittenConfig()).toBe(false);
  });

  it('reports a write failure instead of throwing', () => {
    // A file where the config directory belongs makes mkdir fail.
    fs.writeFileSync(path.join(webAssetsDir, 'assets'), 'blocked');

    writeRuntimeConfig({webAssetsDir, backendUrl: '', logger});

    expect(logger.errors.join('\n')).toContain(
      'Failed to write runtime config file',
    );
  });

  it('writes nothing when the assets directory does not exist', () => {
    const missingDir = path.join(webAssetsDir, 'no-such-bundle');

    writeRuntimeConfig({webAssetsDir: missingDir, backendUrl: '', logger});

    expect(fs.existsSync(missingDir)).toBe(false);
    expect(logger.infos.join('\n')).toContain('does not exist');
  });
});
