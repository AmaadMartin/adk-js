/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentSandboxClient,
  defaultSandboxClientFactory,
  SandboxInfrastructureError,
  SandboxObjectsApi,
  SandboxTimeoutError,
  type AgentSandboxClientOptions,
} from '@google/adk';
import {afterEach, describe, expect, it, Mock, vi} from 'vitest';

// Spies backing the mocked KubeConfig, used by the config-loading tests.
const kubeConfigMock = vi.hoisted(() => ({
  loadFromCluster: vi.fn(),
  loadFromDefault: vi.fn(),
  makeApiClient: vi.fn(),
}));

vi.mock('@kubernetes/client-node', () => ({
  KubeConfig: vi.fn(() => kubeConfigMock),
  CustomObjectsApi: class {},
}));

const CREATED_NAME = 'adk-sandbox-abc';
const NAMESPACE = 'agents';
const GATEWAY = 'my-gateway';

const TEMPLATE = {
  spec: {
    podTemplate: {spec: {containers: [{name: 'python-runtime'}]}},
    volumeClaimTemplates: [{metadata: {name: 'workspace'}}],
  },
};

/** The `Sandbox` manifest the client posts, as the tests read it back. */
interface SandboxManifest {
  apiVersion: string;
  kind: string;
  metadata: {generateName: string; labels: Record<string, string>};
  spec: {podTemplate: unknown; volumeClaimTemplates?: unknown};
}

type FetchCall = Parameters<typeof fetch>;

function readySandbox(podIPs: string[] | undefined = ['10.0.0.5']) {
  return {
    metadata: {name: CREATED_NAME},
    status: {conditions: [{type: 'Ready', status: 'True'}], podIPs},
  };
}

function notReadySandbox() {
  return {
    metadata: {name: CREATED_NAME},
    status: {conditions: [{type: 'Ready', status: 'False'}]},
  };
}

function gatewayWith(address: string | undefined) {
  return {status: {addresses: address ? [{value: address}] : []}};
}

/** Builds an error shaped like the `ApiException` the API clients throw. */
function apiError(code: number, message: string): Error {
  return Object.assign(new Error(message), {code, body: {}, headers: {}});
}

/** Builds a router response. */
function routerResponse({
  status = 200,
  body = {stdout: 'ok', stderr: ''},
}: {status?: number; body?: unknown} = {}): Response {
  return new Response(JSON.stringify(body), {status});
}

function okFetch(): Mock<typeof fetch> {
  return vi.fn<typeof fetch>().mockResolvedValue(routerResponse());
}

function requestUrl(call: FetchCall): string {
  return String(call[0]);
}

function requestHeaders(call: FetchCall): Record<string, string> {
  const headers = call[1]?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) {
    return expect.fail('expected a plain headers object');
  }
  return headers;
}

function formBody(call: FetchCall): FormData {
  const body = call[1]?.body;
  if (!(body instanceof FormData)) {
    return expect.fail('expected a FormData body');
  }
  return body;
}

function jsonBody(call: FetchCall): string {
  const body = call[1]?.body;
  if (typeof body !== 'string') {
    return expect.fail('expected a JSON string body');
  }
  return body;
}

/** Builds a custom-objects fake with a per-resource dispatcher. */
function happyApi() {
  return {
    getNamespacedCustomObject: vi
      .fn<SandboxObjectsApi['getNamespacedCustomObject']>()
      .mockImplementation(({plural}) => {
        if (plural === 'sandboxtemplates') {
          return Promise.resolve(TEMPLATE);
        }
        if (plural === 'sandboxes') {
          return Promise.resolve(readySandbox());
        }
        if (plural === 'gateways') {
          return Promise.resolve(gatewayWith('10.0.0.1'));
        }
        return Promise.reject(new Error(`unexpected plural ${plural}`));
      }),
    createNamespacedCustomObject: vi
      .fn<SandboxObjectsApi['createNamespacedCustomObject']>()
      .mockResolvedValue({metadata: {name: CREATED_NAME}}),
    deleteNamespacedCustomObject: vi
      .fn<SandboxObjectsApi['deleteNamespacedCustomObject']>()
      .mockResolvedValue({}),
  };
}

type FakeApi = ReturnType<typeof happyApi>;

interface SetupOverrides extends Omit<
  Partial<AgentSandboxClientOptions>,
  'fetchFn'
> {
  api?: FakeApi;
  fetchFn?: Mock<typeof fetch>;
}

function setup(overrides: SetupOverrides = {}) {
  const {api = happyApi(), fetchFn = okFetch(), ...clientOptions} = overrides;
  const client = new AgentSandboxClient({
    namespace: NAMESPACE,
    gatewayName: GATEWAY,
    customObjectsApi: api,
    fetchFn,
    ...clientOptions,
  });
  return {client, api, fetchFn};
}

/** Runs `promise` while draining fake timers, for the poll and retry paths. */
async function withTimers<T>(promise: Promise<T>): Promise<T> {
  const [result] = await Promise.all([promise, vi.runAllTimersAsync()]);
  return result;
}

/** Reads the manifest the client posted to create the Sandbox. */
function createdManifest(api: FakeApi): SandboxManifest {
  return api.createNamespacedCustomObject.mock.calls[0][0].body;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  kubeConfigMock.loadFromCluster.mockReset();
  kubeConfigMock.loadFromDefault.mockReset();
  kubeConfigMock.makeApiClient.mockReset();
});

describe('AgentSandboxClient.write', () => {
  it('provisions a sandbox and uploads the file with routing headers', async () => {
    const {client, api, fetchFn} = setup();

    await client.write('script.py', 'print("hi")');

    expect(api.createNamespacedCustomObject).toHaveBeenCalledTimes(1);
    const createArg = api.createNamespacedCustomObject.mock.calls[0][0];
    expect(createArg.group).toBe('agents.x-k8s.io');
    expect(createArg.plural).toBe('sandboxes');
    const manifest = createdManifest(api);
    expect(manifest.metadata.generateName).toBe('adk-sandbox-');
    expect(manifest.metadata.labels['agents.x-k8s.io/created-by']).toBe(
      'adk-js-client',
    );
    expect(manifest.spec.podTemplate).toEqual(TEMPLATE.spec.podTemplate);
    expect(manifest.spec.volumeClaimTemplates).toEqual(
      TEMPLATE.spec.volumeClaimTemplates,
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = fetchFn.mock.calls[0];
    expect(requestUrl(call)).toBe('http://10.0.0.1/upload');
    expect(call[1]?.method).toBe('POST');
    expect(call[1]?.redirect).toBe('manual');
    const file = formBody(call).get('file');
    if (!(file instanceof File)) {
      expect.fail('expected an uploaded File');
    }
    expect(file.name).toBe('script.py');
    expect(await file.text()).toBe('print("hi")');

    const headers = requestHeaders(call);
    expect(headers['X-Sandbox-ID']).toBe(CREATED_NAME);
    expect(headers['X-Sandbox-Namespace']).toBe(NAMESPACE);
    expect(headers['X-Sandbox-Port']).toBe('8888');
    expect(headers['X-Sandbox-Pod-IP']).toBe('10.0.0.5');
    expect(headers['X-Request-ID']).toEqual(expect.any(String));
    expect(Number(headers['X-Sandbox-Timeout'])).toBeGreaterThan(0);
    // The multipart Content-Type is set by fetch, not by the client.
    expect(headers['Content-Type']).toBeUndefined();
  });

  it.each(['', '.', '..', 'dir/script.py', 'a/b'])(
    'rejects the non-plain filename %p before any request',
    async (path) => {
      const {client, api, fetchFn} = setup();

      await expect(client.write(path, 'x')).rejects.toThrow(
        'expected a plain filename',
      );
      expect(api.createNamespacedCustomObject).not.toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('retries a 503 and a network error, then succeeds', async () => {
    vi.useFakeTimers();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(routerResponse({status: 503}))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(routerResponse({status: 200}));
    const {client} = setup({fetchFn});

    await withTimers(client.write('script.py', 'code'));

    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('throws on a non-retryable 4xx without retrying', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(routerResponse({status: 400}));
    const {client} = setup({fetchFn});

    await expect(client.write('script.py', 'code')).rejects.toBeInstanceOf(
      SandboxInfrastructureError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting its retries', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error('down'));
    const {client} = setup({fetchFn});

    await withTimers(
      expect(client.write('script.py', 'code')).rejects.toThrow(
        'failed after 6 attempts',
      ),
    );
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it('times out mid-retry when the request budget is exhausted', async () => {
    vi.useFakeTimers();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(routerResponse({status: 503}));
    const {client} = setup({fetchFn, timeoutSeconds: 1});

    await withTimers(
      expect(client.write('script.py', 'code')).rejects.toBeInstanceOf(
        SandboxTimeoutError,
      ),
    );
  });

  it('rejects a 3xx status as an infrastructure error', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(routerResponse({status: 302}));
    const {client} = setup({fetchFn});

    await expect(client.write('script.py', 'code')).rejects.toThrow(
      'unexpected redirect',
    );
  });
});

describe('AgentSandboxClient.run', () => {
  it('executes the command and returns its stdout and stderr', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        routerResponse({body: {stdout: 'hello', stderr: 'warn'}}),
      );
    const {client} = setup({fetchFn});

    const result = await client.run('python3 script.py');

    expect(result).toEqual({stdout: 'hello', stderr: 'warn'});
    const call = fetchFn.mock.calls[0];
    expect(requestUrl(call)).toBe('http://10.0.0.1/execute');
    expect(requestHeaders(call)['Content-Type']).toBe('application/json');
    expect(JSON.parse(jsonBody(call))).toEqual({
      command: 'python3 script.py',
    });
  });

  it('reports the status the command exited with', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      routerResponse({
        body: {stdout: '', stderr: 'boom', exit_code: 3},
      }),
    );
    const {client} = setup({fetchFn});

    expect(await client.run('cmd')).toEqual({
      stdout: '',
      stderr: 'boom',
      exitCode: 3,
    });
  });

  it('reports no status when the response omits the exit code', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(routerResponse({body: {stdout: 'ok'}}));
    const {client} = setup({fetchFn});

    expect((await client.run('cmd')).exitCode).toBeUndefined();
  });

  it('defaults missing stdout and stderr to empty strings', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(routerResponse({body: {}}));
    const {client} = setup({fetchFn});

    expect(await client.run('cmd')).toEqual({stdout: '', stderr: ''});
  });

  it('makes a single attempt on a retryable status', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(routerResponse({status: 503}));
    const {client} = setup({fetchFn});

    await expect(client.run('cmd')).rejects.toBeInstanceOf(
      SandboxInfrastructureError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('maps an aborted request to a sandbox timeout', async () => {
    const timeoutError = Object.assign(new Error('timed out'), {
      name: 'TimeoutError',
    });
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(timeoutError);
    const {client} = setup({fetchFn});

    await expect(client.run('cmd')).rejects.toBeInstanceOf(SandboxTimeoutError);
  });
});

describe('AgentSandboxClient provisioning', () => {
  it('wraps a template lookup failure that threw a non-Error', async () => {
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) =>
      plural === 'sandboxtemplates'
        ? Promise.reject('boom')
        : Promise.resolve(readySandbox()),
    );
    const {client} = setup({api});

    await expect(client.run('cmd')).rejects.toThrow(
      'Failed to get SandboxTemplate "python-sandbox-template": boom',
    );
  });

  it('wraps a sandbox creation failure', async () => {
    const api = happyApi();
    api.createNamespacedCustomObject.mockRejectedValue(new Error('quota'));
    const {client} = setup({api});

    await expect(client.run('cmd')).rejects.toThrow(
      'Failed to create Sandbox: quota',
    );
  });

  it('rejects a template with no spec.podTemplate', async () => {
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) =>
      plural === 'sandboxtemplates'
        ? Promise.resolve({spec: {}})
        : Promise.resolve(readySandbox()),
    );
    const {client} = setup({api});

    await expect(client.run('cmd')).rejects.toThrow('missing spec.podTemplate');
  });

  it('omits volumeClaimTemplates when the template has none', async () => {
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) => {
      if (plural === 'sandboxtemplates') {
        return Promise.resolve({
          spec: {podTemplate: TEMPLATE.spec.podTemplate},
        });
      }
      if (plural === 'sandboxes') {
        return Promise.resolve(readySandbox());
      }
      return Promise.resolve(gatewayWith('10.0.0.1'));
    });
    const {client} = setup({api});

    await client.write('script.py', 'x');

    expect('volumeClaimTemplates' in createdManifest(api).spec).toBe(false);
  });

  it('throws when the created sandbox has no name', async () => {
    const api = happyApi();
    api.createNamespacedCustomObject.mockResolvedValue({metadata: {}});
    const {client} = setup({api});

    await expect(client.run('cmd')).rejects.toThrow(
      'Failed to create Sandbox: created Sandbox has no name',
    );
  });

  it('provisions once across write and run', async () => {
    const {client, api} = setup();

    await client.write('script.py', 'x');
    await client.run('python3 script.py');

    expect(api.createNamespacedCustomObject).toHaveBeenCalledTimes(1);
  });
});

describe('AgentSandboxClient readiness', () => {
  it('polls until the sandbox reports Ready=True', async () => {
    vi.useFakeTimers();
    const api = happyApi();
    api.getNamespacedCustomObject
      .mockImplementationOnce(() => Promise.resolve(TEMPLATE))
      .mockImplementationOnce(() => Promise.resolve(notReadySandbox()))
      .mockImplementationOnce(() => Promise.resolve(readySandbox()))
      .mockImplementation(() => Promise.resolve(gatewayWith('10.0.0.1')));
    const {client, fetchFn} = setup({api});

    await withTimers(client.write('script.py', 'x'));

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('times out when the sandbox never becomes ready', async () => {
    vi.useFakeTimers();
    const api = happyApi();
    // A sandbox with no status.conditions still counts as not ready.
    api.getNamespacedCustomObject.mockImplementation(({plural}) =>
      plural === 'sandboxtemplates'
        ? Promise.resolve(TEMPLATE)
        : Promise.resolve({metadata: {name: CREATED_NAME}, status: {}}),
    );
    const {client} = setup({api, timeoutSeconds: 1});

    await withTimers(
      expect(client.run('cmd')).rejects.toBeInstanceOf(SandboxTimeoutError),
    );
  });

  it('treats a 404 during readiness as a deleted sandbox', async () => {
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) =>
      plural === 'sandboxtemplates'
        ? Promise.resolve(TEMPLATE)
        : Promise.reject(apiError(404, 'gone')),
    );
    const {client} = setup({api});

    await expect(client.run('cmd')).rejects.toThrow(
      'was deleted before becoming ready',
    );
  });

  it('wraps a readiness read error that is not a 404', async () => {
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) =>
      plural === 'sandboxtemplates'
        ? Promise.resolve(TEMPLATE)
        : Promise.reject(apiError(500, 'boom')),
    );
    const {client} = setup({api});

    await expect(client.run('cmd')).rejects.toThrow('Failed to read Sandbox');
  });

  it.each([
    ['absent podIPs', undefined],
    ['an invalid pod IP', ['not-an-ip']],
  ])('omits the pod IP header for %s', async (_label, podIPs) => {
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) => {
      if (plural === 'sandboxtemplates') {
        return Promise.resolve(TEMPLATE);
      }
      if (plural === 'sandboxes') {
        return Promise.resolve({
          metadata: {name: CREATED_NAME},
          status: {conditions: [{type: 'Ready', status: 'True'}], podIPs},
        });
      }
      return Promise.resolve(gatewayWith('10.0.0.1'));
    });
    const {client, fetchFn} = setup({api});

    await client.write('script.py', 'x');

    expect(
      requestHeaders(fetchFn.mock.calls[0])['X-Sandbox-Pod-IP'],
    ).toBeUndefined();
  });
});

describe('AgentSandboxClient endpoint discovery', () => {
  it('brackets an IPv6 gateway address', async () => {
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) => {
      if (plural === 'sandboxtemplates') {
        return Promise.resolve(TEMPLATE);
      }
      if (plural === 'sandboxes') {
        return Promise.resolve(readySandbox());
      }
      return Promise.resolve(gatewayWith('2001:db8::1'));
    });
    const {client, fetchFn} = setup({api});

    await client.write('script.py', 'x');

    expect(requestUrl(fetchFn.mock.calls[0])).toBe(
      'http://[2001:db8::1]/upload',
    );
  });

  it('rejects unsafe addresses and polls until a valid one appears', async () => {
    vi.useFakeTimers();
    const badAddresses = ['1.2.3.4/evil', 'bad_host', 'a'.repeat(254)];
    const api = happyApi();
    let gatewayCall = 0;
    api.getNamespacedCustomObject.mockImplementation(({plural}) => {
      if (plural === 'sandboxtemplates') {
        return Promise.resolve(TEMPLATE);
      }
      if (plural === 'sandboxes') {
        return Promise.resolve(readySandbox());
      }
      const address = badAddresses[gatewayCall] ?? 'good.example.com';
      gatewayCall++;
      return Promise.resolve(gatewayWith(address));
    });
    const {client, fetchFn} = setup({api});

    await withTimers(client.write('script.py', 'x'));

    expect(requestUrl(fetchFn.mock.calls[0])).toBe(
      'http://good.example.com/upload',
    );
  });

  it('times out when the gateway never reports a valid address', async () => {
    vi.useFakeTimers();
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) => {
      if (plural === 'sandboxtemplates') {
        return Promise.resolve(TEMPLATE);
      }
      if (plural === 'sandboxes') {
        return Promise.resolve(readySandbox());
      }
      return Promise.resolve(gatewayWith(undefined));
    });
    const {client} = setup({api, timeoutSeconds: 1});

    await withTimers(
      expect(client.run('cmd')).rejects.toThrow(
        'did not report a valid address',
      ),
    );
  });

  it('reports a gateway that is not there', async () => {
    vi.useFakeTimers();
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) => {
      if (plural === 'sandboxtemplates') {
        return Promise.resolve(TEMPLATE);
      }
      if (plural === 'sandboxes') {
        return Promise.resolve(readySandbox());
      }
      return Promise.reject(apiError(404, 'nope'));
    });
    const {client} = setup({api, timeoutSeconds: 1});

    await withTimers(
      expect(client.run('cmd')).rejects.toThrow(
        'Gateway "my-gateway" not found',
      ),
    );
  });

  it('falls back to the in-cluster service address', async () => {
    const {client, fetchFn} = setup({
      gatewayName: undefined,
      serverPort: 9999,
    });

    await client.write('script.py', 'x');

    expect(requestUrl(fetchFn.mock.calls[0])).toBe(
      `http://${CREATED_NAME}.${NAMESPACE}.svc.cluster.local:9999/upload`,
    );
  });
});

describe('AgentSandboxClient.close', () => {
  it('deletes the provisioned sandbox', async () => {
    const {client, api} = setup();

    await client.write('script.py', 'x');
    await client.close();

    expect(api.deleteNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({plural: 'sandboxes', name: CREATED_NAME}),
    );
  });

  it('does nothing when the sandbox was never provisioned', async () => {
    const {client, api} = setup();

    await client.close();

    expect(api.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('treats a 404 on delete as success', async () => {
    const api = happyApi();
    api.deleteNamespacedCustomObject.mockRejectedValue(apiError(404, 'gone'));
    const {client} = setup({api});

    await client.write('script.py', 'x');

    await expect(client.close()).resolves.toBeUndefined();
  });

  it('does not throw on other delete errors', async () => {
    const api = happyApi();
    api.deleteNamespacedCustomObject.mockRejectedValue(new Error('boom'));
    const {client} = setup({api});

    await client.write('script.py', 'x');

    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe('AgentSandboxClient config loading', () => {
  function clientWithoutApi(fetchFn = okFetch()) {
    return new AgentSandboxClient({
      namespace: NAMESPACE,
      gatewayName: GATEWAY,
      fetchFn,
    });
  }

  it('uses in-cluster config when it is available', async () => {
    kubeConfigMock.makeApiClient.mockReturnValue(happyApi());

    await clientWithoutApi().write('script.py', 'x');

    expect(kubeConfigMock.loadFromCluster).toHaveBeenCalledTimes(1);
    expect(kubeConfigMock.loadFromDefault).not.toHaveBeenCalled();
  });

  it('falls back to the local kubeconfig', async () => {
    kubeConfigMock.loadFromCluster.mockImplementation(() => {
      throw new Error('not in cluster');
    });
    kubeConfigMock.makeApiClient.mockReturnValue(happyApi());

    await clientWithoutApi().write('script.py', 'x');

    expect(kubeConfigMock.loadFromCluster).toHaveBeenCalledTimes(1);
    expect(kubeConfigMock.loadFromDefault).toHaveBeenCalledTimes(1);
  });

  it('reports that no Kubernetes configuration could be loaded', async () => {
    kubeConfigMock.loadFromCluster.mockImplementation(() => {
      throw new Error('not in cluster');
    });
    kubeConfigMock.loadFromDefault.mockImplementation(() => {
      throw new Error('no kubeconfig');
    });

    await expect(clientWithoutApi().run('cmd')).rejects.toThrow(
      'Failed to load Kubernetes configuration',
    );
  });
});

describe('defaultSandboxClientFactory', () => {
  it('builds an AgentSandboxClient from the factory options', () => {
    const client = defaultSandboxClientFactory({
      namespace: NAMESPACE,
      templateName: 'python-sandbox-template',
      gatewayName: GATEWAY,
    });

    expect(client).toBeInstanceOf(AgentSandboxClient);
  });
});
