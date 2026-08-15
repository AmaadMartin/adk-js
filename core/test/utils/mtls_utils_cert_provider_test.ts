/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
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
import {createMtlsDispatcher} from '../../src/utils/mtls_utils.js';

const {agentCtor, spawnMock} = vi.hoisted(() => ({
  agentCtor: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('undici', () => ({Agent: agentCtor}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

const HOME = '/home/user';
const METADATA_PATH = join(
  HOME,
  '.secureConnect',
  'context_aware_metadata.json',
);
const CONFIG_PATH = '/certs/certificate_config.json';
const PROVIDER_ARGV = ['/usr/bin/cert-provider', '--print'];

const LEAF_CERT =
  '-----BEGIN CERTIFICATE-----\nleaf-material\n-----END CERTIFICATE-----\n';
const ISSUER_CERT =
  '-----BEGIN CERTIFICATE-----\nissuer-material\n-----END CERTIFICATE-----\n';
const PRIVATE_KEY =
  '-----BEGIN RSA PRIVATE KEY-----\nkey-material\n-----END RSA PRIVATE KEY-----\n';

/** A stand-in for the child process `spawn` returns. */
class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & {
    setEncoding(encoding: string): void;
  };
  readonly kill = vi.fn();

  constructor() {
    super();
    this.stdout.setEncoding = () => {};
  }
}

let child: FakeChildProcess;
let warnSpy: MockInstance<(...args: unknown[]) => void>;
const originalEnv = process.env;

/**
 * Makes the provider command write `stdout` and then exit with `code`, so a
 * case only states the output it cares about.
 */
function respondWith(stdout: string, code = 0) {
  spawnMock.mockImplementation(() => {
    queueMicrotask(() => {
      if (stdout) {
        child.stdout.emit('data', stdout);
      }
      child.emit('close', code);
    });
    return child;
  });
}

/** Serves the Secure Connect metadata file and nothing else. */
function mockSecureConnectMetadata(metadata: unknown) {
  vi.mocked(readFile).mockImplementation(async (file) => {
    if (file === METADATA_PATH) {
      return JSON.stringify(metadata);
    }
    throw new Error(`ENOENT: no such file or directory, open '${file}'`);
  });
}

describe('mtls_utils cert_provider_command', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    child = new FakeChildProcess();
    vi.mocked(homedir).mockReturnValue(HOME);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env = {
      ...originalEnv,
      GOOGLE_API_USE_CLIENT_CERTIFICATE: 'true',
      // Point the workload source at a path that does not exist, so every case
      // here falls through to Secure Connect.
      GOOGLE_API_CERTIFICATE_CONFIG: CONFIG_PATH,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('runs the command from the metadata file with no shell', async () => {
    mockSecureConnectMetadata({cert_provider_command: PROVIDER_ARGV});
    respondWith(LEAF_CERT + PRIVATE_KEY);

    await expect(createMtlsDispatcher()).resolves.toBeDefined();

    expect(readFile).toHaveBeenCalledWith(METADATA_PATH, 'utf8');
    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/cert-provider',
      ['--print'],
      {
        shell: false,
      },
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('takes a certificate chain as one block alongside the key', async () => {
    mockSecureConnectMetadata({cert_provider_command: PROVIDER_ARGV});
    respondWith(LEAF_CERT + ISSUER_CERT + PRIVATE_KEY);

    await createMtlsDispatcher();

    expect(agentCtor).toHaveBeenCalledWith({
      connect: {cert: LEAF_CERT + ISSUER_CERT, key: PRIVATE_KEY},
    });
  });

  it('prefers the workload certificate when both sources are configured', async () => {
    const workloadCert = Buffer.from('-----BEGIN CERTIFICATE----- workload');
    const workloadKey = Buffer.from('-----BEGIN PRIVATE KEY----- workload');
    vi.mocked(readFile).mockImplementation(async (file) => {
      switch (file) {
        case CONFIG_PATH:
          return JSON.stringify({
            cert_configs: {
              workload: {cert_path: '/certs/w.pem', key_path: '/certs/w.key'},
            },
          });
        case '/certs/w.pem':
          return workloadCert;
        case '/certs/w.key':
          return workloadKey;
        case METADATA_PATH:
          return JSON.stringify({cert_provider_command: PROVIDER_ARGV});
        default:
          throw new Error(`ENOENT: '${file}'`);
      }
    });
    respondWith(LEAF_CERT + PRIVATE_KEY);

    await createMtlsDispatcher();

    expect(agentCtor).toHaveBeenCalledWith({
      connect: {cert: workloadCert, key: workloadKey},
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports both sources when neither supplies a certificate', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    await expect(createMtlsDispatcher()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).toContain(CONFIG_PATH);
    expect(message).toContain(METADATA_PATH);
  });

  it('warns when the metadata file has no cert_provider_command', async () => {
    mockSecureConnectMetadata({});

    await expect(createMtlsDispatcher()).resolves.toBeUndefined();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('no cert_provider_command');
  });

  it.each([
    ['the command exits non-zero', LEAF_CERT + PRIVATE_KEY, 1],
    ['the output has no key block', LEAF_CERT, 0],
    ['the output has no certificate block', PRIVATE_KEY, 0],
  ])('warns and falls back when %s', async (_name, stdout, code) => {
    mockSecureConnectMetadata({cert_provider_command: PROVIDER_ARGV});
    respondWith(stdout, code);

    await expect(createMtlsDispatcher()).resolves.toBeUndefined();

    expect(agentCtor).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'the key is encrypted',
      LEAF_CERT +
        '-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----\n',
    ],
    [
      'the output carries a passphrase',
      LEAF_CERT +
        PRIVATE_KEY +
        '-----BEGIN PASSPHRASE-----\npw\n-----END PASSPHRASE-----\n',
    ],
  ])('refuses the certificate when %s', async (_name, stdout) => {
    mockSecureConnectMetadata({cert_provider_command: PROVIDER_ARGV});
    respondWith(stdout);

    await expect(createMtlsDispatcher()).resolves.toBeUndefined();

    expect(agentCtor).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('encrypted private key');
  });

  it('kills the command and falls back when it writes too much', async () => {
    mockSecureConnectMetadata({cert_provider_command: PROVIDER_ARGV});
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'x'.repeat(1024 * 1024 + 1));
      });
      return child;
    });

    await expect(createMtlsDispatcher()).resolves.toBeUndefined();

    expect(child.kill).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('more than');
  });

  it('kills the command and falls back when it never exits', async () => {
    vi.useFakeTimers();
    mockSecureConnectMetadata({cert_provider_command: PROVIDER_ARGV});
    spawnMock.mockImplementation(() => child);

    const pending = createMtlsDispatcher();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('timed out');
    vi.useRealTimers();
  });

  it('falls back when the command cannot be spawned', async () => {
    mockSecureConnectMetadata({cert_provider_command: PROVIDER_ARGV});
    spawnMock.mockImplementation(() => {
      queueMicrotask(() =>
        child.emit('error', new Error('ENOENT cert-provider')),
      );
      return child;
    });

    await expect(createMtlsDispatcher()).resolves.toBeUndefined();

    expect(warnSpy.mock.calls[0][0]).toContain('ENOENT cert-provider');
  });

  it('never logs certificate or key material', async () => {
    mockSecureConnectMetadata({cert_provider_command: PROVIDER_ARGV});
    respondWith(LEAF_CERT + PRIVATE_KEY);
    agentCtor.mockImplementation(() => {
      throw new Error('dispatcher construction failed');
    });

    await expect(createMtlsDispatcher()).resolves.toBeUndefined();

    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).not.toContain('BEGIN CERTIFICATE');
    expect(message).not.toContain('PRIVATE KEY');
    expect(message).not.toContain('leaf-material');
    expect(message).not.toContain('key-material');
  });
});
