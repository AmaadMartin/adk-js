/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Agent} from 'undici';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {AgentRegistry} from '../../src/index.js';
import {createMtlsDispatcher} from '../../src/utils/mtls_utils.js';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue({
      getRequestHeaders: vi.fn().mockResolvedValue({
        'Authorization': 'Bearer fake-token',
      }),
    }),
  })),
}));

// Only the certificate loading is faked; the endpoint-resolution helpers run
// for real so the tests exercise the actual rewrite rules.
vi.mock('../../src/utils/mtls_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/mtls_utils.js')>()),
  createMtlsDispatcher: vi.fn(),
}));

const PLAIN_BASE_URL = 'https://agentregistry.googleapis.com/v1alpha';
const MTLS_BASE_URL = 'https://agentregistry.mtls.googleapis.com/v1alpha';

const dispatcher = new Agent();
const originalEnv = process.env;
const fetchMock = vi.fn<typeof fetch>();

/** Returns the url and init of the nth recorded fetch call. */
function fetchCall(index: number) {
  const call = fetchMock.mock.calls[index];
  expect(call).toBeDefined();
  return {url: String(call[0]), init: call[1]};
}

describe('AgentRegistry mTLS', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    const env = {...originalEnv};
    delete env['GOOGLE_API_USE_MTLS_ENDPOINT'];
    delete env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];
    process.env = env;

    vi.mocked(createMtlsDispatcher).mockResolvedValue(undefined);
    fetchMock.mockImplementation(async () => new Response('{"agents": []}'));
    global.fetch = fetchMock;

    registry = new AgentRegistry({
      projectId: 'test-project',
      location: 'global',
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  afterAll(async () => {
    await dispatcher.close();
  });

  it('uses the plain host with no dispatcher when no certificate is available', async () => {
    await registry.listAgents();

    const {url, init} = fetchCall(0);
    expect(url.startsWith(PLAIN_BASE_URL)).toBe(true);
    expect(init).not.toHaveProperty('dispatcher');
  });

  it('uses the mTLS host and attaches the dispatcher when a certificate is available', async () => {
    vi.mocked(createMtlsDispatcher).mockResolvedValue(dispatcher);

    await registry.listAgents();

    const {url, init} = fetchCall(0);
    expect(url.startsWith(MTLS_BASE_URL)).toBe(true);
    expect(init).toHaveProperty('dispatcher', dispatcher);
  });

  it('uses the mTLS host without a dispatcher when the setting is "always"', async () => {
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'always';

    await registry.listAgents();

    const {url, init} = fetchCall(0);
    expect(url.startsWith(MTLS_BASE_URL)).toBe(true);
    expect(init).not.toHaveProperty('dispatcher');
  });

  it('keeps the plain host when the setting is "never" despite a certificate', async () => {
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'never';
    vi.mocked(createMtlsDispatcher).mockResolvedValue(dispatcher);

    await registry.listAgents();

    const {url, init} = fetchCall(0);
    expect(url.startsWith(PLAIN_BASE_URL)).toBe(true);
    expect(init).toHaveProperty('dispatcher', dispatcher);
  });

  it('loads the certificate once across sequential requests', async () => {
    vi.mocked(createMtlsDispatcher).mockResolvedValue(dispatcher);

    await registry.listAgents();
    await registry.listAgents();

    expect(createMtlsDispatcher).toHaveBeenCalledTimes(1);
    expect(fetchCall(1).url.startsWith(MTLS_BASE_URL)).toBe(true);
  });

  it('loads the certificate once across concurrent first requests', async () => {
    vi.mocked(createMtlsDispatcher).mockResolvedValue(dispatcher);

    await Promise.all([registry.listAgents(), registry.listAgents()]);

    expect(createMtlsDispatcher).toHaveBeenCalledTimes(1);
  });

  it('loads the certificate per instance', async () => {
    vi.mocked(createMtlsDispatcher).mockResolvedValue(dispatcher);

    await registry.listAgents();
    await new AgentRegistry({
      projectId: 'test-project',
      location: 'global',
    }).listAgents();

    expect(createMtlsDispatcher).toHaveBeenCalledTimes(2);
  });
});
