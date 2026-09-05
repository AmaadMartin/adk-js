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
  LOGO_CONFIG_ERROR_MESSAGE,
  validateLogoOptions,
  writeRuntimeConfig,
} from '../../src/server/runtime_config.js';
import {CapturingLogger} from '../capturing_logger.js';
import {setHomeDir} from '../temp_home.js';

const LOGO = {logoText: 'Acme', logoImageUrl: 'https://acme.example/logo.svg'};

describe('writeRuntimeConfig', () => {
  let webAssetsDir: string;
  let configPath: string;
  let logger: CapturingLogger;
  let restoreHomeDir: () => void;

  beforeEach(async () => {
    webAssetsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-web-assets-'));
    configPath = path.join(
      webAssetsDir,
      'assets',
      'config',
      'runtime-config.json',
    );
    logger = new CapturingLogger();
    // No `~/.adk/config.json` here, so the recorded consent is always null.
    restoreHomeDir = setHomeDir(webAssetsDir);
  });

  afterEach(async () => {
    restoreHomeDir();
    await fs.rm(webAssetsDir, {recursive: true, force: true});
  });

  async function readConfig(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(configPath, 'utf-8'));
  }

  async function writeExistingConfig(contents: string): Promise<void> {
    await fs.mkdir(path.dirname(configPath), {recursive: true});
    await fs.writeFile(configPath, contents, 'utf-8');
  }

  it('creates the file when it is missing', async () => {
    await writeRuntimeConfig(webAssetsDir, {}, logger);

    expect(await readConfig()).toEqual({backendUrl: '', telemetry: null});
    expect(logger.infoMessages.join('\n')).toContain('File not found');
  });

  it('writes the recorded telemetry consent', async () => {
    await fs.mkdir(path.join(webAssetsDir, '.adk'), {recursive: true});
    await fs.writeFile(
      path.join(webAssetsDir, '.adk', 'config.json'),
      JSON.stringify({telemetry: true}),
      'utf-8',
    );

    await writeRuntimeConfig(webAssetsDir, {}, logger);

    expect((await readConfig())['telemetry']).toBe(true);
  });

  it('writes the url prefix as backendUrl', async () => {
    await writeRuntimeConfig(webAssetsDir, {urlPrefix: '/adk'}, logger);

    expect((await readConfig())['backendUrl']).toBe('/adk');
  });

  it('preserves keys it does not own and overwrites the ones it does', async () => {
    await writeExistingConfig(
      JSON.stringify({backendUrl: '/stale', theme: 'dark'}),
    );

    await writeRuntimeConfig(webAssetsDir, {urlPrefix: '/adk'}, logger);

    expect(await readConfig()).toEqual({
      backendUrl: '/adk',
      theme: 'dark',
      telemetry: null,
    });
  });

  it('overwrites a file that is not valid JSON, and warns', async () => {
    await writeExistingConfig('not json at all');

    await writeRuntimeConfig(webAssetsDir, {}, logger);

    expect(await readConfig()).toEqual({backendUrl: '', telemetry: null});
    expect(logger.warnMessages.join('\n')).toContain('Failed to decode JSON');
  });

  it('overwrites a file holding JSON that is not an object, and warns', async () => {
    await writeExistingConfig('[1, 2, 3]');

    await writeRuntimeConfig(webAssetsDir, {}, logger);

    expect(await readConfig()).toEqual({backendUrl: '', telemetry: null});
    expect(logger.warnMessages.join('\n')).toContain('Failed to decode JSON');
  });

  it('writes the logo block when both halves are set', async () => {
    await writeRuntimeConfig(webAssetsDir, LOGO, logger);

    expect((await readConfig())['logo']).toEqual({
      text: 'Acme',
      imageUrl: 'https://acme.example/logo.svg',
    });
  });

  it('removes a logo the file already held when none is configured', async () => {
    await writeExistingConfig(
      JSON.stringify({logo: {text: 'Old', imageUrl: 'https://old.example/l'}}),
    );

    await writeRuntimeConfig(webAssetsDir, {}, logger);

    expect(await readConfig()).not.toHaveProperty('logo');
  });

  it('rejects a logo with only the text set', async () => {
    await expect(
      writeRuntimeConfig(webAssetsDir, {logoText: 'Acme'}, logger),
    ).rejects.toThrow(LOGO_CONFIG_ERROR_MESSAGE);
  });

  it('rejects a logo with only the image url set', async () => {
    await expect(
      writeRuntimeConfig(
        webAssetsDir,
        {logoImageUrl: 'https://acme.example/logo.svg'},
        logger,
      ),
    ).rejects.toThrow(LOGO_CONFIG_ERROR_MESSAGE);
  });

  it('does not write the file when the logo is rejected', async () => {
    await expect(
      writeRuntimeConfig(webAssetsDir, {logoText: 'Acme'}, logger),
    ).rejects.toThrow(LOGO_CONFIG_ERROR_MESSAGE);

    await expect(fs.access(configPath)).rejects.toThrow();
  });

  it('logs and keeps going when the file cannot be written', async () => {
    // A file where the config directory belongs: mkdir and write both fail.
    await fs.mkdir(path.join(webAssetsDir, 'assets'), {recursive: true});
    await fs.writeFile(
      path.join(webAssetsDir, 'assets', 'config'),
      '',
      'utf-8',
    );

    await writeRuntimeConfig(webAssetsDir, {}, logger);

    expect(logger.errorMessages.join('\n')).toContain(
      'Failed to write runtime config file',
    );
  });

  it('writes two-space indent and a trailing newline', async () => {
    await writeRuntimeConfig(webAssetsDir, {urlPrefix: '/adk'}, logger);

    const contents = await fs.readFile(configPath, 'utf-8');
    expect(contents).toBe(
      '{\n  "backendUrl": "/adk",\n  "telemetry": null\n}\n',
    );
  });
});

describe('validateLogoOptions', () => {
  it('accepts both halves set', () => {
    expect(() => validateLogoOptions(LOGO)).not.toThrow();
  });

  it('accepts neither half set', () => {
    expect(() => validateLogoOptions({})).not.toThrow();
  });

  it('rejects exactly one half set', () => {
    expect(() => validateLogoOptions({logoText: 'Acme'})).toThrow(
      LOGO_CONFIG_ERROR_MESSAGE,
    );
  });
});
