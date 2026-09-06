/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * These tests run the real certificate provider command in a subprocess and
 * read a real metadata file, so nothing about `defaultClientCertSource` is
 * stubbed. `os.homedir()` reads `HOME` on POSIX and `USERPROFILE` on Windows,
 * which is how the metadata file is redirected into a temporary directory.
 */

import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';

import {logger} from '../../src/utils/logger.js';
import {defaultClientCertSource} from '../../src/utils/mtls_utils.js';

const CERT = [
  '-----BEGIN CERTIFICATE-----',
  'bm90LWEtY2VydA==',
  '-----END CERTIFICATE-----',
].join('\n');
const KEY = [
  '-----BEGIN EC PRIVATE KEY-----',
  'bm90LWEta2V5',
  '-----END EC PRIVATE KEY-----',
].join('\n');

describe('defaultClientCertSource', () => {
  let home: string;
  let warn: MockInstance<(...args: unknown[]) => void>;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'adk-mtls-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(home, {recursive: true, force: true});
  });

  /** Writes the gcloud context-aware metadata file into the fake home. */
  async function writeMetadata(contents: string): Promise<void> {
    const directory = join(home, '.secureConnect');
    await mkdir(directory, {recursive: true});
    await writeFile(join(directory, 'context_aware_metadata.json'), contents);
  }

  /** A provider command that prints `output` and exits successfully. */
  function commandPrinting(output: string): string[] {
    return [
      process.execPath,
      '-e',
      `process.stdout.write(${JSON.stringify(output)})`,
    ];
  }

  it('returns the certificate and the key the provider command prints', async () => {
    await writeMetadata(
      JSON.stringify({
        cert_provider_command: commandPrinting(`${CERT}\n${KEY}\n`),
      }),
    );

    await expect(defaultClientCertSource()).resolves.toEqual({
      cert: CERT,
      key: KEY,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns nothing, without warning, when there is no metadata file', async () => {
    await expect(defaultClientCertSource()).resolves.toBeUndefined();

    // Every machine that is not enrolled in context-aware access takes this
    // path, so it must stay quiet.
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when the metadata file is not JSON', async () => {
    await writeMetadata('{ this is not json');

    await expect(defaultClientCertSource()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse'),
      expect.anything(),
    );
  });

  it('warns when the metadata file registers no provider command', async () => {
    await writeMetadata(JSON.stringify({version: 1}));

    await expect(defaultClientCertSource()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('does not name a `cert_provider_command`'),
    );
  });

  it('warns when the provider command is not a list of strings', async () => {
    await writeMetadata(JSON.stringify({cert_provider_command: 'gcloud'}));

    await expect(defaultClientCertSource()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('does not name a `cert_provider_command`'),
    );
  });

  it('warns when the provider command is an empty list', async () => {
    await writeMetadata(JSON.stringify({cert_provider_command: []}));

    await expect(defaultClientCertSource()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('does not name a `cert_provider_command`'),
    );
  });

  it('warns when the provider command exits with a failure', async () => {
    await writeMetadata(
      JSON.stringify({
        cert_provider_command: [process.execPath, '-e', 'process.exit(3)'],
      }),
    );

    await expect(defaultClientCertSource()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      expect.anything(),
    );
  });

  it('warns when the provider command prints no key', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: commandPrinting(CERT)}),
    );

    await expect(defaultClientCertSource()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('printed no certificate and private key pair'),
    );
  });

  it('warns when the provider command prints no certificate', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: commandPrinting(KEY)}),
    );

    await expect(defaultClientCertSource()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('printed no certificate and private key pair'),
    );
  });
});
