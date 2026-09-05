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
  LOGO_CONFIG_ERROR_MESSAGE,
  setupRuntimeConfig,
} from '../../src/server/runtime_config.js';
import {CapturingLogger} from '../capturing_logger.js';

const CONFIG_RELATIVE_PATH = path.join(
  'assets',
  'config',
  'runtime-config.json',
);

describe('setupRuntimeConfig', () => {
  let webAssetsDir: string;
  let home: string;
  let originalHome: string | undefined;
  let logger: CapturingLogger;

  beforeEach(() => {
    webAssetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-web-assets-'));
    // The consent value comes from `$HOME/.adk/config.json`, so each test gets
    // an empty home rather than the developer's real one.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-runtime-home-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logger = new CapturingLogger();
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    fs.rmSync(webAssetsDir, {recursive: true, force: true});
    fs.rmSync(home, {recursive: true, force: true});
  });

  function configPath(): string {
    return path.join(webAssetsDir, CONFIG_RELATIVE_PATH);
  }

  function writeExistingConfig(contents: string): void {
    fs.mkdirSync(path.dirname(configPath()), {recursive: true});
    fs.writeFileSync(configPath(), contents, 'utf-8');
  }

  function readWrittenConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  }

  function writeConsent(value: string): void {
    fs.mkdirSync(path.join(home, '.adk'), {recursive: true});
    fs.writeFileSync(
      path.join(home, '.adk', 'config.json'),
      `{"telemetry": ${value}}`,
      'utf-8',
    );
  }

  it('creates the file with an empty backend URL and no recorded consent', () => {
    setupRuntimeConfig(webAssetsDir, {}, logger);

    expect(readWrittenConfig()).toEqual({backendUrl: '', telemetry: null});
    expect(logger.infoMessages[0]).toContain(
      'A new runtime config file will be created',
    );
  });

  it('writes the recorded telemetry consent', () => {
    writeConsent('true');

    setupRuntimeConfig(webAssetsDir, {}, logger);

    expect(readWrittenConfig()['telemetry']).toBe(true);
  });

  it('writes an opt-out as false rather than dropping it', () => {
    writeConsent('false');

    setupRuntimeConfig(webAssetsDir, {}, logger);

    expect(readWrittenConfig()['telemetry']).toBe(false);
  });

  it('writes the configured backend URL prefix', () => {
    setupRuntimeConfig(webAssetsDir, {urlPrefix: '/adk'}, logger);

    expect(readWrittenConfig()['backendUrl']).toBe('/adk');
  });

  it('ends the file with a newline and two-space indentation', () => {
    setupRuntimeConfig(webAssetsDir, {}, logger);

    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(
      '{\n  "backendUrl": "",\n  "telemetry": null\n}\n',
    );
  });

  it('keeps keys the dev UI build shipped', () => {
    writeExistingConfig('{"featureFlags": {"beta": true}}');

    setupRuntimeConfig(webAssetsDir, {}, logger);

    expect(readWrittenConfig()['featureFlags']).toEqual({beta: true});
  });

  it('overwrites a malformed file and warns', () => {
    writeExistingConfig('{not json');

    setupRuntimeConfig(webAssetsDir, {}, logger);

    expect(readWrittenConfig()).toEqual({backendUrl: '', telemetry: null});
    expect(logger.warnMessages[0]).toContain(
      'The file content will be overwritten',
    );
  });

  it('overwrites a file that holds something other than an object', () => {
    writeExistingConfig('[1, 2]');

    setupRuntimeConfig(webAssetsDir, {}, logger);

    expect(readWrittenConfig()).toEqual({backendUrl: '', telemetry: null});
  });

  it('writes both logo fields when both are configured', () => {
    setupRuntimeConfig(
      webAssetsDir,
      {logoText: 'Acme Agents', logoImageUrl: 'https://example.com/acme.svg'},
      logger,
    );

    expect(readWrittenConfig()['logo']).toEqual({
      text: 'Acme Agents',
      imageUrl: 'https://example.com/acme.svg',
    });
  });

  it('drops a logo inherited from the existing file when none is configured', () => {
    writeExistingConfig('{"logo": {"text": "Old", "imageUrl": "old.svg"}}');

    setupRuntimeConfig(webAssetsDir, {}, logger);

    expect(readWrittenConfig()).not.toHaveProperty('logo');
  });

  it('rejects a logo text with no image URL', () => {
    expect(() =>
      setupRuntimeConfig(webAssetsDir, {logoText: 'Acme Agents'}, logger),
    ).toThrowError(LOGO_CONFIG_ERROR_MESSAGE);
  });

  it('rejects a logo image URL with no text', () => {
    expect(() =>
      setupRuntimeConfig(
        webAssetsDir,
        {logoImageUrl: 'https://example.com/acme.svg'},
        logger,
      ),
    ).toThrowError(LOGO_CONFIG_ERROR_MESSAGE);
  });

  it('writes nothing when the logo pair is rejected', () => {
    expect(() =>
      setupRuntimeConfig(webAssetsDir, {logoText: 'Acme Agents'}, logger),
    ).toThrowError(LOGO_CONFIG_ERROR_MESSAGE);

    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('reports a write failure without throwing', () => {
    // A regular file where the `assets` directory must go makes `mkdir -p`
    // fail, which is the closest reproducible stand-in for an unwritable
    // install directory.
    fs.writeFileSync(path.join(webAssetsDir, 'assets'), 'not a directory');

    setupRuntimeConfig(webAssetsDir, {}, logger);

    expect(logger.errorMessages).toHaveLength(1);
    expect(logger.errorMessages[0]).toContain(
      'Failed to write runtime config file',
    );
  });
});
