/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  Context,
  createSession,
  DiscoveryDocument,
  GoogleApiToolset,
  InvocationContext,
  PluginManager,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockedFunction,
  vi,
} from 'vitest';
import {CALENDAR_DISCOVERY_DOCUMENT} from './discovery_fixtures.js';
import {respondWith} from './https_transport_fake.js';

/** What a test reads back from one fake `undici` `Agent`. */
interface AgentRecord {
  /** The options the agent was constructed with. */
  options: unknown;
  /** How many times the agent was closed. */
  closes: number;
}

const {requestMock, execFileMock, homedirMock, agents} = vi.hoisted(() => ({
  requestMock: vi.fn(),
  execFileMock: vi.fn(),
  homedirMock: vi.fn(),
  agents: [] as AgentRecord[],
}));

vi.mock('node:https', () => ({request: requestMock, Agent: vi.fn()}));

vi.mock('node:child_process', () => ({execFile: execFileMock}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    default: {...actual, homedir: homedirMock},
    homedir: homedirMock,
  };
});

vi.mock('undici', () => {
  class FakeAgent {
    private readonly record: AgentRecord;

    constructor(options: unknown) {
      this.record = {options, closes: 0};
      agents.push(this.record);
    }

    dispatch(): boolean {
      return true;
    }

    async close(): Promise<void> {
      this.record.closes++;
    }
  }
  return {Agent: FakeAgent};
});

const CERT_PEM =
  '-----BEGIN CERTIFICATE-----\nMIIByGVsbG8=\n-----END CERTIFICATE-----';
const KEY_PEM =
  '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIBa2V5\n' +
  '-----END ENCRYPTED PRIVATE KEY-----';
const PASSPHRASE_BLOCK =
  '-----BEGIN PASSPHRASE-----\n0123456789abcdef\n-----END PASSPHRASE-----';
const PASSPHRASE = '0123456789abcdef';

const PROVIDER_COMMAND = ['/opt/secure-connect/cert_provider', '--json'];

/** The tool names the calendar fixture converts to. */
const CALENDAR_TOOL_NAMES = [
  'calendar.calendars.get',
  'calendar.calendars.insert',
  'calendar.events.list',
];

/**
 * A calendar document whose root URL carries a placeholder no server variable
 * declares, so the OpenAPI parser rejects the converted spec.
 */
const UNCONVERTIBLE_DOCUMENT: DiscoveryDocument = {
  ...CALENDAR_DISCOVERY_DOCUMENT,
  rootUrl: 'https://{location}-calendar.googleapis.com/',
};

/**
 * A context that already holds the exchanged OpenID Connect credential, so a
 * tool run reaches the transport instead of stopping to ask for consent.
 */
function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        state: {
          'openIdConnect_existing_exchanged_credential': {
            authType: AuthCredentialTypes.HTTP,
            http: {scheme: 'bearer', credentials: {token: 'test-token'}},
          },
        },
      }),
      pluginManager: new PluginManager(),
    }),
  });
}

/** Reads Node's non-standard `dispatcher` option off a `fetch` call. */
function dispatcherOf(init: object | undefined): unknown {
  return init && 'dispatcher' in init ? init.dispatcher : undefined;
}

/** Makes the mocked `execFile` print `stdout` as the certificate provider. */
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

describe('GoogleApiToolset mTLS', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: MockedFunction<typeof globalThis.fetch>;
  let homeDir: string;

  beforeEach(async () => {
    agents.length = 0;
    requestMock.mockReset();
    execFileMock.mockReset();
    respondWith(requestMock, {
      statusCode: 200,
      body: JSON.stringify(CALENDAR_DISCOVERY_DOCUMENT),
    });
    providerPrints([CERT_PEM, KEY_PEM, PASSPHRASE_BLOCK].join('\n'));

    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-toolset-mtls-'));
    homedirMock.mockReturnValue(homeDir);

    fetchMock = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response('{}', {headers: {'content-type': 'application/json'}}),
    );
    globalThis.fetch = fetchMock;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    await fs.rm(homeDir, {recursive: true, force: true});
  });

  /** Writes the SecureConnect metadata into the fake home directory. */
  async function writeMetadata(contents: string): Promise<void> {
    const secureConnect = path.join(homeDir, '.secureConnect');
    await fs.mkdir(secureConnect, {recursive: true});
    await fs.writeFile(
      path.join(secureConnect, 'context_aware_metadata.json'),
      contents,
      'utf-8',
    );
  }

  /** Asks for a client certificate and makes one available to load. */
  async function requestClientCertificate(): Promise<void> {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    await writeMetadata(
      JSON.stringify({cert_provider_command: PROVIDER_COMMAND}),
    );
  }

  function createToolset(): GoogleApiToolset {
    return new GoogleApiToolset({apiName: 'calendar', apiVersion: 'v3'});
  }

  /** Runs the toolset's first tool and returns the `fetch` options it sent. */
  async function runFirstTool(toolset: GoogleApiToolset) {
    const [tool] = await toolset.getTools();
    await tool.runAsync({args: {}, toolContext: createToolContext()});
    return fetchMock.mock.calls[0][1] ?? {};
  }

  it('presents the client certificate on a tool request', async () => {
    await requestClientCertificate();
    const toolset = createToolset();

    const init = await runFirstTool(toolset);

    expect(agents).toHaveLength(1);
    expect(agents[0].options).toStrictEqual({
      connect: {cert: CERT_PEM, key: KEY_PEM, passphrase: PASSPHRASE},
    });
    expect(init).toHaveProperty('dispatcher');
  });

  it('gives every tool the same dispatcher', async () => {
    await requestClientCertificate();
    const toolset = createToolset();

    for (const tool of await toolset.getTools()) {
      await tool.runAsync({args: {}, toolContext: createToolContext()});
    }

    const dispatchers = fetchMock.mock.calls.map(([, init]) =>
      dispatcherOf(init),
    );
    expect(dispatchers).toHaveLength(CALENDAR_TOOL_NAMES.length);
    expect(new Set(dispatchers).size).toBe(1);
    expect(dispatchers[0]).toBeDefined();
  });

  // adk-python passes the two-tuple cert=("cert", "key") here rather than a
  // three-tuple holding a None, so `toStrictEqual` rejects a `passphrase` key
  // that is present and undefined.
  it('omits the passphrase when the provider prints none', async () => {
    providerPrints([CERT_PEM, KEY_PEM].join('\n'));
    await requestClientCertificate();

    await createToolset().getTools();

    expect(agents[0].options).toStrictEqual({
      connect: {cert: CERT_PEM, key: KEY_PEM},
    });
  });

  it('releases the certificate when the toolset closes', async () => {
    await requestClientCertificate();
    const toolset = createToolset();
    await toolset.getTools();

    await toolset.close();

    expect(agents[0].closes).toBe(1);
  });

  it('closes twice without throwing', async () => {
    await requestClientCertificate();
    const toolset = createToolset();
    await toolset.getTools();

    await toolset.close();

    await expect(toolset.close()).resolves.toBeUndefined();
    expect(agents[0].closes).toBe(1);
  });

  it('builds a fresh dispatcher when the toolset is used after a close', async () => {
    await requestClientCertificate();
    const toolset = createToolset();
    await toolset.getTools();
    await toolset.close();

    await toolset.getTools();

    expect(agents).toHaveLength(2);
    expect(agents[1].closes).toBe(0);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  // A runner closes its toolsets after every invocation, so a toolset that
  // forgot its tools here would refetch the Discovery document once per turn.
  it('keeps the memoised tools across a close with no certificate', async () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);
    const toolset = createToolset();
    await toolset.getTools();

    await toolset.close();
    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(CALENDAR_TOOL_NAMES);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('reads no certificate and sends no dispatcher by default', async () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);
    const toolset = createToolset();

    const init = await runFirstTool(toolset);

    expect(agents).toHaveLength(0);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(init).not.toHaveProperty('dispatcher');
  });

  it('builds the tools without a dispatcher when the machine has no certificate', async () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    const toolset = createToolset();

    const tools = await toolset.getTools();
    const init = await runFirstTool(toolset);

    expect(tools.map((tool) => tool.name)).toEqual(CALENDAR_TOOL_NAMES);
    expect(agents).toHaveLength(0);
    expect(init).not.toHaveProperty('dispatcher');
  });

  it('releases the dispatcher when the toolset fails to build', async () => {
    await requestClientCertificate();
    respondWith(requestMock, {
      statusCode: 200,
      body: JSON.stringify(UNCONVERTIBLE_DOCUMENT),
    });
    const toolset = createToolset();

    await expect(toolset.getTools()).rejects.toThrow(
      'Unresolved server URL variable',
    );

    expect(agents).toHaveLength(1);
    expect(agents[0].closes).toBe(1);
  });

  it('retries after a failed build, and closes only the second dispatcher', async () => {
    await requestClientCertificate();
    respondWith(requestMock, {
      statusCode: 200,
      body: JSON.stringify(UNCONVERTIBLE_DOCUMENT),
    });
    const toolset = createToolset();
    await expect(toolset.getTools()).rejects.toThrow(
      'Unresolved server URL variable',
    );
    respondWith(requestMock, {
      statusCode: 200,
      body: JSON.stringify(CALENDAR_DISCOVERY_DOCUMENT),
    });

    const tools = await toolset.getTools();
    await toolset.close();

    expect(tools.map((tool) => tool.name)).toEqual(CALENDAR_TOOL_NAMES);
    expect(agents).toHaveLength(2);
    expect(agents[1].closes).toBe(1);
  });
});
