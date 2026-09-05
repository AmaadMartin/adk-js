/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';
import {
  clientCertsToPresent,
  getApiEndpoint,
  hasDefaultClientCertSource,
  loadDefaultClientCerts,
  useClientCertEffective,
} from '../../src/utils/mtls_utils.js';

const {execFileMock, homedirMock} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  homedirMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({execFile: execFileMock}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    default: {...actual, homedir: homedirMock},
    homedir: homedirMock,
  };
});

const DEFAULT_ENDPOINT = 'https://agentregistry.googleapis.com/v1alpha';
const MTLS_ENDPOINT = 'https://agentregistry.mtls.googleapis.com/v1alpha';

function endpoint(): string {
  return getApiEndpoint(DEFAULT_ENDPOINT, MTLS_ENDPOINT);
}

describe('getApiEndpoint', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-mtls-home-'));
    homedirMock.mockReturnValue(homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(homeDir, {recursive: true, force: true});
  });

  /** Gives the machine a certificate source the loader can read. */
  async function writeDefaultMetadata(): Promise<void> {
    const dir = path.join(homeDir, '.secureConnect');
    await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(
      path.join(dir, 'context_aware_metadata.json'),
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
      'utf-8',
    );
  }

  it('returns the default host when neither variable is set', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', undefined);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);

    expect(endpoint()).toBe(DEFAULT_ENDPOINT);
  });

  it('returns the mTLS host when the setting is always', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);

    expect(endpoint()).toBe(MTLS_ENDPOINT);
  });

  it('reads the setting case insensitively', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'ALWAYS');

    expect(endpoint()).toBe(MTLS_ENDPOINT);
  });

  it('returns the default host when the setting is never', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(endpoint()).toBe(DEFAULT_ENDPOINT);
  });

  it('returns the mTLS host for auto with a client certificate', async () => {
    await writeDefaultMetadata();
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'TRUE');

    expect(endpoint()).toBe(MTLS_ENDPOINT);
  });

  it('returns the default host for auto without a client certificate', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');

    expect(endpoint()).toBe(DEFAULT_ENDPOINT);
  });

  it('returns the default host for auto when the machine has no certificate to present', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(endpoint()).toBe(DEFAULT_ENDPOINT);
  });

  it('returns the mTLS host for always even with no certificate to present', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');

    expect(endpoint()).toBe(MTLS_ENDPOINT);
  });

  it('warns and treats an unrecognised setting as auto', async () => {
    await writeDefaultMetadata();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'sometimes');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(endpoint()).toBe(MTLS_ENDPOINT);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('GOOGLE_API_USE_MTLS_ENDPOINT'),
    );
    warn.mockRestore();
  });
});

describe('hasDefaultClientCertSource', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-mtls-home-'));
    homedirMock.mockReturnValue(homeDir);
  });

  afterEach(async () => {
    await fs.rm(homeDir, {recursive: true, force: true});
  });

  it('is false when the machine has no context-aware metadata', () => {
    expect(hasDefaultClientCertSource()).toBe(false);
  });

  it('is true once the context-aware metadata exists', async () => {
    const dir = path.join(homeDir, '.secureConnect');
    await fs.mkdir(dir, {recursive: true});
    await fs.writeFile(
      path.join(dir, 'context_aware_metadata.json'),
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
      'utf-8',
    );

    expect(hasDefaultClientCertSource()).toBe(true);
  });
});

const CERT_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIByGVsbG8=\n-----END CERTIFICATE-----';
const KEY_PEM =
  '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIBa2V5\n' +
  '-----END ENCRYPTED PRIVATE KEY-----';
const PASSPHRASE_BLOCK =
  '-----BEGIN PASSPHRASE-----\n  0123456789abcdef  \n-----END PASSPHRASE-----';

const PROVIDER_COMMAND = ['/opt/secure-connect/cert_provider', '--json'];

/** Makes the mocked `execFile` succeed, printing `stdout`. */
function providerPrints(stdout: string): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: object,
      callback: (
        error: unknown,
        output: {stdout: string; stderr: string},
      ) => void,
    ) => {
      callback(null, {stdout, stderr: ''});
    },
  );
}

/** Makes the mocked `execFile` fail with `error`. */
function providerFails(error: unknown): void {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: object,
      callback: (error: unknown) => void,
    ) => {
      callback(error);
    },
  );
}

describe('useClientCertEffective', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('is false when the variable is unset', () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);

    expect(useClientCertEffective()).toBe(false);
  });

  it.each(['true', 'TRUE', 'True'])('is true for %s', (value) => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', value);

    expect(useClientCertEffective()).toBe(true);
  });

  it.each(['false', 'FALSE'])('is false for %s without warning', (value) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', value);

    expect(useClientCertEffective()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['yes', '1', ''])('warns and is false for "%s"', (value) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', value);

    expect(useClientCertEffective()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('GOOGLE_API_USE_CLIENT_CERTIFICATE'),
    );
  });
});

describe('loadDefaultClientCerts', () => {
  let tempDir: string;
  let metadataPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-mtls-'));
    metadataPath = path.join(
      tempDir,
      '.secureConnect',
      'context_aware_metadata.json',
    );
    homedirMock.mockReturnValue(tempDir);
    providerPrints([CERT_PEM, KEY_PEM, PASSPHRASE_BLOCK].join('\n'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  /** Writes the SecureConnect metadata the loader will read. */
  async function writeMetadata(contents: string): Promise<void> {
    await fs.mkdir(path.dirname(metadataPath), {recursive: true});
    await fs.writeFile(metadataPath, contents, 'utf-8');
  }

  it('resolves undefined when the machine has no metadata file', async () => {
    await expect(loadDefaultClientCerts()).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('propagates a read failure that is not a missing file', async () => {
    await fs.mkdir(metadataPath, {recursive: true});

    await expect(loadDefaultClientCerts()).rejects.toThrow();
  });

  it('throws naming the file when it is not valid JSON', async () => {
    await writeMetadata('{ not json');

    await expect(loadDefaultClientCerts()).rejects.toThrow(
      `${metadataPath} is not valid JSON.`,
    );
  });

  it.each([
    {name: 'the key is absent', contents: '{}'},
    {name: 'the document is a JSON array', contents: '[]'},
    {name: 'the document is a JSON null', contents: 'null'},
    {
      name: 'the command is not an array',
      contents: JSON.stringify({cert_provider_command: 'run-me'}),
    },
    {
      name: 'the command is empty',
      contents: JSON.stringify({cert_provider_command: []}),
    },
    {
      name: 'the command holds a non-string',
      contents: JSON.stringify({cert_provider_command: ['run-me', 7]}),
    },
  ])('throws when $name', async ({contents}) => {
    await writeMetadata(contents);

    await expect(loadDefaultClientCerts()).rejects.toThrow(
      'declares no cert_provider_command string array',
    );
  });

  it('returns the certificate, key and trimmed passphrase', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );

    await expect(loadDefaultClientCerts()).resolves.toEqual({
      cert: CERT_PEM,
      key: KEY_PEM,
      passphrase: '0123456789abcdef',
    });
  });

  it('asks the provider for the passphrase', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );

    await loadDefaultClientCerts();

    expect(execFileMock).toHaveBeenCalledWith(
      '/opt/secure-connect/cert_provider',
      ['--json', '--with_passphrase'],
      {encoding: 'utf-8'},
      expect.any(Function),
    );
  });

  it('does not ask for the passphrase twice', async () => {
    await writeMetadata(
      JSON.stringify({
        cert_provider_command: [...PROVIDER_COMMAND, '--with_passphrase'],
      }),
    );

    await loadDefaultClientCerts();

    expect(execFileMock).toHaveBeenCalledWith(
      '/opt/secure-connect/cert_provider',
      ['--json', '--with_passphrase'],
      {encoding: 'utf-8'},
      expect.any(Function),
    );
  });

  it('accepts provider output that carries no passphrase', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );
    providerPrints([CERT_PEM, KEY_PEM].join('\n'));

    await expect(loadDefaultClientCerts()).resolves.toEqual({
      cert: CERT_PEM,
      key: KEY_PEM,
    });
  });

  it.each([
    {name: 'the certificate', stdout: KEY_PEM},
    {name: 'the private key', stdout: CERT_PEM},
  ])('throws when the provider prints no $name', async ({stdout}) => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );
    providerPrints(stdout);

    await expect(loadDefaultClientCerts()).rejects.toThrow(
      'printed no certificate and private key pair',
    );
  });

  it('throws with the exit status when the provider fails', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );
    providerFails(Object.assign(new Error('Command failed'), {code: 1}));

    await expect(loadDefaultClientCerts()).rejects.toThrow(
      `The certificate provider named by ${metadataPath} failed with 1.`,
    );
  });

  it('throws when the provider fails without an exit status', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );
    providerFails('spawn failed');

    await expect(loadDefaultClientCerts()).rejects.toThrow(
      'failed with an unknown error.',
    );
  });

  it('keeps the certificate material out of a provider failure message', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );
    providerFails(new Error(`stderr contained ${KEY_PEM}`));

    await expect(loadDefaultClientCerts()).rejects.toThrow(
      /^(?!.*PRIVATE KEY)/s,
    );
  });
});

describe('clientCertsToPresent', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-mtls-'));
    homedirMock.mockReturnValue(tempDir);
    providerPrints([CERT_PEM, KEY_PEM].join('\n'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  /** Writes the SecureConnect metadata into the fake home directory. */
  async function writeHomeMetadata(contents: string): Promise<void> {
    const secureConnect = path.join(tempDir, '.secureConnect');
    await fs.mkdir(secureConnect, {recursive: true});
    await fs.writeFile(
      path.join(secureConnect, 'context_aware_metadata.json'),
      contents,
      'utf-8',
    );
  }

  it('does not look for a certificate when the variable is unset', async () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);
    await writeHomeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );

    await expect(clientCertsToPresent()).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('loads the certificate when the variable asks for one', async () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    await writeHomeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );

    await expect(clientCertsToPresent()).resolves.toEqual({
      cert: CERT_PEM,
      key: KEY_PEM,
    });
  });

  it('resolves undefined when the machine has no metadata file', async () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    await expect(clientCertsToPresent()).resolves.toBeUndefined();
  });

  it('warns once and resolves undefined when the load fails', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    await writeHomeMetadata('not json');

    await expect(clientCertsToPresent()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('is not valid JSON');
  });
});
