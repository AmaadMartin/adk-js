/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EventEmitter} from 'node:events';
import * as fs from 'node:fs/promises';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
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
import {
  chooseApiEndpoint,
  chooseApiEndpointForDefaultCerts,
  clientCertDispatcher,
  clientCertsToPresent,
  defaultClientCertSource,
  effectiveGoogleapisEndpoint,
  getApiEndpoint,
  getWithClientCert,
  hasDefaultClientCertSource,
  loadDefaultClientCerts,
  shouldUseMtlsEndpoint,
  useClientCertEffective,
} from '../../src/utils/mtls_utils.js';

const {execFileMock, homedirMock, httpsRequestMock} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  homedirMock: vi.fn(),
  httpsRequestMock: vi.fn<FakeHttpsRequest>(),
}));

vi.mock('node:child_process', () => ({execFile: execFileMock}));

// `https.Agent` stays real, so the assertions read the certificate material
// that was handed to Node.
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof https>();
  return {
    ...actual,
    default: {...actual, request: httpsRequestMock},
    request: httpsRequestMock,
  };
});

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

  it('substitutes a location containing replacement patterns verbatim', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', undefined);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);

    expect(getApiEndpoint("$&$`$'", DEFAULT_TEMPLATE, MTLS_TEMPLATE)).toBe(
      "$&$`$'-integrations.googleapis.com",
    );
  });

  it('leaves a template with no placeholder unchanged', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');

    expect(
      getApiEndpoint(
        'global',
        'integrations.googleapis.com',
        'integrations.mtls.googleapis.com',
      ),
    ).toBe('integrations.mtls.googleapis.com');
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

/**
 * Makes the mocked `execFile` run the command for real.
 *
 * `defaultClientCertSource` is tested end to end: it reads a real metadata
 * file and it runs a real provider in a subprocess. Only the callback shape is
 * adapted, because the mock stands in for `execFile` before `promisify` wraps
 * it.
 */
async function providerRunsForReal(): Promise<void> {
  const {execFile} =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  execFileMock.mockImplementation(
    (
      file: string,
      args: string[],
      callback: (
        error: unknown,
        output: {stdout: string; stderr: string},
      ) => void,
    ) => {
      execFile(file, args, (error, stdout, stderr) => {
        callback(error, {stdout, stderr});
      });
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

const DEFAULT_ENDPOINT = 'https://cloudapiregistry.googleapis.com';
const MTLS_ENDPOINT = 'https://cloudapiregistry.mtls.googleapis.com';

describe('chooseApiEndpoint', () => {
  const certs = {cert: CERT_PEM, key: KEY_PEM};

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('selects the mTLS endpoint under always, with no certificate', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'ALWAYS');
    expect(chooseApiEndpoint(undefined, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      MTLS_ENDPOINT,
    );
  });

  it('selects the default endpoint under never, even with a certificate', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');
    expect(chooseApiEndpoint(certs, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      DEFAULT_ENDPOINT,
    );
  });

  it('selects the mTLS endpoint under auto when a certificate is available', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    expect(chooseApiEndpoint(certs, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      MTLS_ENDPOINT,
    );
  });

  it('selects the default endpoint under auto with no certificate', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    expect(chooseApiEndpoint(undefined, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      DEFAULT_ENDPOINT,
    );
  });

  it('reads an unset setting as auto', () => {
    expect(chooseApiEndpoint(certs, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      MTLS_ENDPOINT,
    );
    expect(chooseApiEndpoint(undefined, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      DEFAULT_ENDPOINT,
    );
  });

  it('reads an unrecognised setting as auto', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'nonsense');
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(chooseApiEndpoint(certs, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      MTLS_ENDPOINT,
    );
    expect(chooseApiEndpoint(undefined, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      DEFAULT_ENDPOINT,
    );
  });
});

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

describe('shouldUseMtlsEndpoint', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports true for always, whatever the certificate setting', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');

    expect(shouldUseMtlsEndpoint()).toBe(true);
  });

  it('reports false for never, whatever the certificate setting', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(shouldUseMtlsEndpoint()).toBe(false);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('defers to the certificate setting %s for auto', (value, expected) => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', value);

    expect(shouldUseMtlsEndpoint()).toBe(expected);
  });

  it('treats an unset setting as auto', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', undefined);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(shouldUseMtlsEndpoint()).toBe(true);
  });

  it('treats an unrecognised setting as auto', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'sometimes');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(shouldUseMtlsEndpoint()).toBe(true);
  });

  it('reads the setting case insensitively', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'ALWAYS');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');

    expect(shouldUseMtlsEndpoint()).toBe(true);
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
      {encoding: 'utf-8', timeout: 30_000},
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
      {encoding: 'utf-8', timeout: 30_000},
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

describe('defaultClientCertSource', () => {
  let home: string;
  let warn: MockInstance<(...args: unknown[]) => void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-mtls-'));
    homedirMock.mockReturnValue(home);
    await providerRunsForReal();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(home, {recursive: true, force: true});
  });

  /** Writes the gcloud context-aware metadata file into the fake home. */
  async function writeMetadata(contents: string): Promise<void> {
    const directory = path.join(home, '.secureConnect');
    await fs.mkdir(directory, {recursive: true});
    await fs.writeFile(
      path.join(directory, 'context_aware_metadata.json'),
      contents,
    );
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
        cert_provider_command: commandPrinting(`${CERT_PEM}\n${KEY_PEM}\n`),
      }),
    );

    await expect(defaultClientCertSource()).resolves.toEqual({
      cert: CERT_PEM,
      key: KEY_PEM,
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
      JSON.stringify({cert_provider_command: commandPrinting(CERT_PEM)}),
    );

    await expect(defaultClientCertSource()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('printed no certificate and private key pair'),
    );
  });

  it('warns when the provider command prints no certificate', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: commandPrinting(KEY_PEM)}),
    );

    await expect(defaultClientCertSource()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('printed no certificate and private key pair'),
    );
  });
});

describe('effectiveGoogleapisEndpoint', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rewrites a googleapis.com host to its mutual-TLS variant', () => {
    expect(
      effectiveGoogleapisEndpoint('https://apihub.googleapis.com/v1'),
    ).toBe('https://apihub.mtls.googleapis.com/v1');
  });

  it('keeps the path, the query and the fragment', () => {
    expect(
      effectiveGoogleapisEndpoint(
        'https://apihub.googleapis.com/v1/projects/p/apis?pageSize=10#top',
      ),
    ).toBe(
      'https://apihub.mtls.googleapis.com/v1/projects/p/apis?pageSize=10#top',
    );
  });

  it('keeps a non-default port', () => {
    expect(
      effectiveGoogleapisEndpoint('https://apihub.googleapis.com:8443/v1'),
    ).toBe('https://apihub.mtls.googleapis.com:8443/v1');
  });

  it('returns the url unchanged when the setting is never', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');

    expect(
      effectiveGoogleapisEndpoint('https://apihub.googleapis.com/v1'),
    ).toBe('https://apihub.googleapis.com/v1');
  });

  it('reads the opt-out case insensitively', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'NEVER');

    expect(
      effectiveGoogleapisEndpoint('https://apihub.googleapis.com/v1'),
    ).toBe('https://apihub.googleapis.com/v1');
  });

  it('leaves a host that is not a googleapis.com host alone', () => {
    expect(effectiveGoogleapisEndpoint('https://example.com/v1')).toBe(
      'https://example.com/v1',
    );
  });

  it('leaves a host that is already a mutual-TLS host alone', () => {
    expect(
      effectiveGoogleapisEndpoint('https://apihub.mtls.googleapis.com/v1'),
    ).toBe('https://apihub.mtls.googleapis.com/v1');
  });

  it('rewrites a regional host', () => {
    expect(
      effectiveGoogleapisEndpoint(
        'https://us-central1-integrations.googleapis.com',
      ),
    ).toBe('https://us-central1-integrations.mtls.googleapis.com/');
  });

  it.each(['', 'not a url'])('leaves "%s" alone, which is no url', (url) => {
    expect(effectiveGoogleapisEndpoint(url)).toBe(url);
  });

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

/** The part of an outgoing request the transport drives. */
interface FakeRequest extends EventEmitter {
  end(): void;
  destroy(error?: Error): void;
}

/** The part of an incoming response the transport reads. */
interface FakeResponse extends EventEmitter {
  /** Node leaves this unset when the response carries no status line. */
  statusCode?: number;
  setEncoding(encoding: string): void;
}

/** The request options the transport passes to `https.request`. */
interface FakeRequestOptions {
  headers: Record<string, string>;
  timeout: number;
  agent: https.Agent;
}

type FakeHttpsRequest = (
  url: string,
  options: FakeRequestOptions,
  onResponse: (response: FakeResponse) => void,
) => FakeRequest;

describe('getWithClientCert', () => {
  const URL = 'https://apihub.mtls.googleapis.com/v1/apis';
  const HEADERS = {'accept': 'application/json', 'Authorization': 'Bearer t'};
  const CERTS = {cert: CERT_PEM, key: KEY_PEM, passphrase: 'secret'};
  const TIMEOUT_MS = 30_000;

  beforeEach(() => {
    httpsRequestMock.mockReset();
  });

  /** Builds a request that reports a `destroy()` as Node does, with an error. */
  function fakeRequest(end: () => void): FakeRequest {
    const request: FakeRequest = Object.assign(new EventEmitter(), {
      end,
      destroy: (error?: Error) => {
        request.emit('error', error);
      },
    });
    return request;
  }

  /** Makes the mocked `https.request` answer with a body. */
  function respondWith(body: string, statusCode?: number): void {
    httpsRequestMock.mockImplementation((_url, _options, onResponse) =>
      fakeRequest(() => {
        const response: FakeResponse = Object.assign(new EventEmitter(), {
          statusCode,
          setEncoding: () => {},
        });
        onResponse(response);
        response.emit('data', body);
        response.emit('end');
      }),
    );
  }

  /** Makes the mocked `https.request` never answer, and returns the request. */
  function staysPending(): FakeRequest {
    const request = fakeRequest(() => {});
    httpsRequestMock.mockImplementation(() => request);
    return request;
  }

  it('presents the certificate and keeps the headers and the deadline', async () => {
    respondWith('{"apis":[]}', 200);

    await expect(
      getWithClientCert(URL, HEADERS, CERTS, TIMEOUT_MS),
    ).resolves.toEqual({status: 200, body: '{"apis":[]}'});
    const options = httpsRequestMock.mock.calls[0][1];
    expect(httpsRequestMock.mock.calls[0][0]).toBe(URL);
    expect(options.headers).toEqual(HEADERS);
    expect(options.timeout).toBe(TIMEOUT_MS);
    expect(options.agent.options).toMatchObject(CERTS);
  });

  it('reports the status of a failed response', async () => {
    respondWith('forbidden', 403);

    await expect(
      getWithClientCert(URL, HEADERS, CERTS, TIMEOUT_MS),
    ).resolves.toEqual({status: 403, body: 'forbidden'});
  });

  it('reports a response with no status code as status 0', async () => {
    respondWith('', undefined);

    await expect(
      getWithClientCert(URL, HEADERS, CERTS, TIMEOUT_MS),
    ).resolves.toEqual({status: 0, body: ''});
  });

  it('rejects when the response stream errors', async () => {
    httpsRequestMock.mockImplementation((_url, _options, onResponse) =>
      fakeRequest(() => {
        const response: FakeResponse = Object.assign(new EventEmitter(), {
          statusCode: 200,
          setEncoding: () => {},
        });
        onResponse(response);
        response.emit('error', new Error('stream aborted'));
      }),
    );

    await expect(
      getWithClientCert(URL, HEADERS, CERTS, TIMEOUT_MS),
    ).rejects.toThrow('stream aborted');
  });

  // The rejection value is asserted rather than matched with
  // `rejects.toThrow()`, which passes on a promise that rejects with
  // `undefined` and would not see a `destroy()` that carries no error.
  it('destroys a request that reaches its deadline', async () => {
    const request = staysPending();

    const failure = getWithClientCert(URL, HEADERS, CERTS, TIMEOUT_MS);
    request.emit('timeout');
    const error = await failure.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty(
      'message',
      `Request timed out after ${TIMEOUT_MS} ms: ${URL}`,
    );
  });

  it('rejects when the socket errors', async () => {
    const request = staysPending();

    const failure = getWithClientCert(URL, HEADERS, CERTS, TIMEOUT_MS);
    request.emit('error', new Error('socket hang up'));
    const error = await failure.catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('message', 'socket hang up');
  });
});

describe('clientCertDispatcher', () => {
  const CERTS = {cert: CERT_PEM, key: KEY_PEM, passphrase: 'secret'};

  it('builds a closable dispatcher for a passphrase-protected key', async () => {
    const dispatcher = await clientCertDispatcher(CERTS);

    expect(dispatcher.dispatch).toBeTypeOf('function');
    expect(dispatcher.close).toBeTypeOf('function');
    await dispatcher.close();
  });

  it('builds one for a key with no passphrase', async () => {
    const dispatcher = await clientCertDispatcher({
      cert: CERT_PEM,
      key: KEY_PEM,
    });

    expect(dispatcher.dispatch).toBeTypeOf('function');
    await dispatcher.close();
  });

  // A caller must therefore close the dispatcher once. GoogleApiToolset drops
  // its reference before it awaits the close, so a second close() on the
  // toolset never reaches a destroyed dispatcher.
  it('rejects a second close, because undici destroys the client', async () => {
    const dispatcher = await clientCertDispatcher(CERTS);

    await dispatcher.close();
    await expect(dispatcher.close()).rejects.toThrow('The client is destroyed');
  });
});

const AGENT_REGISTRY_ENDPOINT = 'https://agentregistry.googleapis.com/v1alpha';
const AGENT_REGISTRY_MTLS_ENDPOINT =
  'https://agentregistry.mtls.googleapis.com/v1alpha';

function agentRegistryEndpoint(): string {
  return chooseApiEndpointForDefaultCerts(
    AGENT_REGISTRY_ENDPOINT,
    AGENT_REGISTRY_MTLS_ENDPOINT,
  );
}

describe('chooseApiEndpointForDefaultCerts', () => {
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

    expect(agentRegistryEndpoint()).toBe(AGENT_REGISTRY_ENDPOINT);
  });

  it('returns the mTLS host when the setting is always', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);

    expect(agentRegistryEndpoint()).toBe(AGENT_REGISTRY_MTLS_ENDPOINT);
  });

  it('reads the setting case insensitively', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'ALWAYS');

    expect(agentRegistryEndpoint()).toBe(AGENT_REGISTRY_MTLS_ENDPOINT);
  });

  it('returns the default host when the setting is never', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(agentRegistryEndpoint()).toBe(AGENT_REGISTRY_ENDPOINT);
  });

  it('returns the mTLS host for auto with a client certificate', async () => {
    await writeDefaultMetadata();
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'TRUE');

    expect(agentRegistryEndpoint()).toBe(AGENT_REGISTRY_MTLS_ENDPOINT);
  });

  it('returns the default host for auto without a client certificate', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');

    expect(agentRegistryEndpoint()).toBe(AGENT_REGISTRY_ENDPOINT);
  });

  it('returns the default host for auto when the machine has no certificate to present', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(agentRegistryEndpoint()).toBe(AGENT_REGISTRY_ENDPOINT);
  });

  it('returns the mTLS host for always even with no certificate to present', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');

    expect(agentRegistryEndpoint()).toBe(AGENT_REGISTRY_MTLS_ENDPOINT);
  });

  it('warns and treats an unrecognised setting as auto', async () => {
    await writeDefaultMetadata();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'sometimes');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(agentRegistryEndpoint()).toBe(AGENT_REGISTRY_MTLS_ENDPOINT);
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
