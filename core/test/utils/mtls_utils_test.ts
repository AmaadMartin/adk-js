/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  effectiveGoogleapisEndpoint,
  getApiEndpoint,
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

const DEFAULT_TEMPLATE = '{location}-integrations.googleapis.com';
const MTLS_TEMPLATE = '{location}-integrations.mtls.googleapis.com';

function endpoint(): string {
  return getApiEndpoint('us-central1', DEFAULT_TEMPLATE, MTLS_TEMPLATE);
}

describe('getApiEndpoint', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the default host when neither variable is set', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', undefined);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);

    expect(endpoint()).toBe('us-central1-integrations.googleapis.com');
  });

  it('returns the mTLS host when the setting is always', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);

    expect(endpoint()).toBe('us-central1-integrations.mtls.googleapis.com');
  });

  it('reads the setting case insensitively', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'ALWAYS');

    expect(endpoint()).toBe('us-central1-integrations.mtls.googleapis.com');
  });

  it('returns the default host when the setting is never', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(endpoint()).toBe('us-central1-integrations.googleapis.com');
  });

  it('returns the mTLS host for auto with a client certificate', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'TRUE');

    expect(endpoint()).toBe('us-central1-integrations.mtls.googleapis.com');
  });

  it('returns the default host for auto without a client certificate', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');

    expect(endpoint()).toBe('us-central1-integrations.googleapis.com');
  });

  it('treats an unrecognised setting as auto', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'sometimes');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(endpoint()).toBe('us-central1-integrations.mtls.googleapis.com');
  });

  it('substitutes the location into the template it returns', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');

    expect(
      getApiEndpoint('europe-west1', DEFAULT_TEMPLATE, MTLS_TEMPLATE),
    ).toBe('europe-west1-integrations.googleapis.com');
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
  const original = process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];

  afterEach(() => {
    if (original === undefined) {
      delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];
    } else {
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = original;
    }
  });

  it('is false when the variable is unset', () => {
    delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];

    expect(useClientCertEffective()).toBe(false);
  });

  it.each(['true', 'TRUE', 'True'])('is true for %s', (value) => {
    process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = value;

    expect(useClientCertEffective()).toBe(true);
  });

  it.each(['false', 'yes', '1', ''])('is false for "%s"', (value) => {
    process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = value;

    expect(useClientCertEffective()).toBe(false);
  });
});

describe('loadDefaultClientCerts', () => {
  let tempDir: string;
  let metadataPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-mtls-'));
    metadataPath = path.join(tempDir, 'context_aware_metadata.json');
    homedirMock.mockReturnValue(tempDir);
    providerPrints([CERT_PEM, KEY_PEM, PASSPHRASE_BLOCK].join('\n'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  /** Writes the SecureConnect metadata the loader will read. */
  async function writeMetadata(contents: string): Promise<void> {
    await fs.writeFile(metadataPath, contents, 'utf-8');
  }

  it('resolves undefined when the machine has no metadata file', async () => {
    await expect(
      loadDefaultClientCerts({metadataPath}),
    ).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('reads ~/.secureConnect when no path is given', async () => {
    const secureConnect = path.join(tempDir, '.secureConnect');
    await fs.mkdir(secureConnect);
    await fs.writeFile(
      path.join(secureConnect, 'context_aware_metadata.json'),
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
      'utf-8',
    );

    await expect(loadDefaultClientCerts()).resolves.toEqual({
      cert: CERT_PEM,
      key: KEY_PEM,
      passphrase: '0123456789abcdef',
    });
  });

  it('propagates a read failure that is not a missing file', async () => {
    await fs.mkdir(metadataPath);

    await expect(loadDefaultClientCerts({metadataPath})).rejects.toThrow();
  });

  it('throws naming the file when it is not valid JSON', async () => {
    await writeMetadata('{ not json');

    await expect(loadDefaultClientCerts({metadataPath})).rejects.toThrow(
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

    await expect(loadDefaultClientCerts({metadataPath})).rejects.toThrow(
      'declares no cert_provider_command string array',
    );
  });

  it('returns the certificate, key and trimmed passphrase', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );

    await expect(loadDefaultClientCerts({metadataPath})).resolves.toEqual({
      cert: CERT_PEM,
      key: KEY_PEM,
      passphrase: '0123456789abcdef',
    });
  });

  it('asks the provider for the passphrase', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );

    await loadDefaultClientCerts({metadataPath});

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

    await loadDefaultClientCerts({metadataPath});

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

    await expect(loadDefaultClientCerts({metadataPath})).resolves.toEqual({
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

    await expect(loadDefaultClientCerts({metadataPath})).rejects.toThrow(
      'printed no certificate and private key pair',
    );
  });

  it('throws with the exit status when the provider fails', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );
    providerFails(Object.assign(new Error('Command failed'), {code: 1}));

    await expect(loadDefaultClientCerts({metadataPath})).rejects.toThrow(
      `The certificate provider named by ${metadataPath} failed with 1.`,
    );
  });

  it('throws when the provider fails without an exit status', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );
    providerFails('spawn failed');

    await expect(loadDefaultClientCerts({metadataPath})).rejects.toThrow(
      'failed with an unknown error.',
    );
  });

  it('keeps the certificate material out of a provider failure message', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );
    providerFails(new Error(`stderr contained ${KEY_PEM}`));

    await expect(loadDefaultClientCerts({metadataPath})).rejects.toThrow(
      /^(?!.*PRIVATE KEY)/s,
    );
  });
});

describe('effectiveGoogleapisEndpoint', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [
      'preserves the path and the query',
      'https://apihub.googleapis.com/v1/x?y=1',
      'https://apihub.mtls.googleapis.com/v1/x?y=1',
    ],
    [
      'preserves a non-default port',
      'https://apihub.googleapis.com:8443/v1/x',
      'https://apihub.mtls.googleapis.com:8443/v1/x',
    ],
    [
      'rewrites a multi-label host',
      'https://us-central1-apihub.googleapis.com/v1',
      'https://us-central1-apihub.mtls.googleapis.com/v1',
    ],
    [
      'leaves a non-googleapis host untouched',
      'https://example.com/v1/x',
      'https://example.com/v1/x',
    ],
    [
      'leaves an mTLS host untouched',
      'https://apihub.mtls.googleapis.com/v1/x',
      'https://apihub.mtls.googleapis.com/v1/x',
    ],
    ['leaves a string that is not a URL untouched', 'not a url', 'not a url'],
  ])('%s', (_name, input, expected) => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', undefined);

    expect(effectiveGoogleapisEndpoint(input)).toBe(expected);
  });

  it.each(['never', 'NEVER'])(
    'returns the input when the setting is %s',
    (setting) => {
      vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', setting);

      expect(
        effectiveGoogleapisEndpoint('https://apihub.googleapis.com/v1'),
      ).toBe('https://apihub.googleapis.com/v1');
    },
  );

  it.each(['auto', 'always', 'nonsense'])(
    'rewrites the host when the setting is %s',
    (setting) => {
      vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', setting);

      expect(
        effectiveGoogleapisEndpoint('https://apihub.googleapis.com/v1'),
      ).toBe('https://apihub.mtls.googleapis.com/v1');
    },
  );
});
