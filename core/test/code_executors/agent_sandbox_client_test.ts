/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentSandboxClient,
  type AgentSandboxClientOptions,
  defaultSandboxClientFactory,
  SandboxInfrastructureError,
  SandboxTimeoutError,
} from '@google/adk';
import {KubeConfig} from '@kubernetes/client-node';
import {afterEach, describe, expect, it, type Mock, vi} from 'vitest';

// Hoisted spies backing the mocked KubeConfig, used by config-loading tests.
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

/** Builds a fetch Response stub. */
function fetchResponse({
  status = 200,
  body = {stdout: 'ok', stderr: ''},
  type = 'basic',
}: {status?: number; body?: unknown; type?: string} = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    type,
    json: async () => body,
  } as unknown as Response;
}

/** The single-object argument shape shared by CustomObjectsApi methods. */
interface ObjectArg {
  group?: string;
  version?: string;
  namespace?: string;
  plural: string;
  name?: string;
}

/** The create argument, with the manifest body we assert on. */
interface CreateArg extends ObjectArg {
  body: {
    apiVersion: string;
    kind: string;
    metadata: {generateName: string; labels: Record<string, string>};
    spec: {podTemplate: unknown; volumeClaimTemplates?: unknown};
  };
}

/** Builds a CustomObjectsApi stub with a per-resource dispatcher. */
function happyApi() {
  return {
    getNamespacedCustomObject: vi.fn<(arg: ObjectArg) => Promise<unknown>>(
      ({plural}) => {
        if (plural === 'sandboxtemplates') return Promise.resolve(TEMPLATE);
        if (plural === 'sandboxes') return Promise.resolve(readySandbox());
        if (plural === 'gateways') {
          return Promise.resolve(gatewayWith('10.0.0.1'));
        }
        return Promise.reject(new Error(`unexpected plural ${plural}`));
      },
    ),
    createNamespacedCustomObject: vi.fn<
      (arg: CreateArg) => Promise<{metadata?: {name?: string}}>
    >(() => Promise.resolve({metadata: {name: CREATED_NAME}})),
    deleteNamespacedCustomObject: vi.fn<(arg: ObjectArg) => Promise<unknown>>(
      () => Promise.resolve({}),
    ),
  };
}

type FakeApi = ReturnType<typeof happyApi>;

interface SetupOverrides extends Omit<
  Partial<AgentSandboxClientOptions>,
  'fetchFn'
> {
  api?: FakeApi;
  fetchFn?: Mock;
}

function setup(overrides: SetupOverrides = {}) {
  const {
    api = happyApi(),
    fetchFn = vi.fn().mockResolvedValue(fetchResponse()),
    ...clientOptions
  } = overrides;
  const kubeConfig = {
    makeApiClient: vi.fn().mockReturnValue(api),
  } as unknown as KubeConfig;
  const client = new AgentSandboxClient({
    namespace: NAMESPACE,
    gatewayName: GATEWAY,
    kubeConfig,
    fetchFn: fetchFn as unknown as typeof fetch,
    ...clientOptions,
  });
  return {client, api, fetchFn, kubeConfig};
}

/** Runs `promise` while draining fake timers (used for poll/retry paths). */
async function withTimers<T>(promise: Promise<T>): Promise<T> {
  const [result] = await Promise.all([promise, vi.runAllTimersAsync()]);
  return result;
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

    // Sandbox created from the template with the created-by label.
    expect(api.createNamespacedCustomObject).toHaveBeenCalledTimes(1);
    const createArg = api.createNamespacedCustomObject.mock.calls[0][0];
    expect(createArg.group).toBe('agents.x-k8s.io');
    expect(createArg.plural).toBe('sandboxes');
    expect(createArg.body.metadata.generateName).toBe('adk-sandbox-');
    expect(createArg.body.metadata.labels['agents.x-k8s.io/created-by']).toBe(
      'adk-js-client',
    );
    expect(createArg.body.spec.podTemplate).toEqual(TEMPLATE.spec.podTemplate);
    expect(createArg.body.spec.volumeClaimTemplates).toEqual(
      TEMPLATE.spec.volumeClaimTemplates,
    );

    // Upload request targets the gateway URL with a multipart body.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://10.0.0.1/upload');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.body).toBeInstanceOf(FormData);
    const file = (init.body as FormData).get('file') as File;
    expect(file.name).toBe('script.py');
    expect(await file.text()).toBe('print("hi")');

    const headers = init.headers as Record<string, string>;
    expect(headers['X-Sandbox-ID']).toBe(CREATED_NAME);
    expect(headers['X-Sandbox-Namespace']).toBe(NAMESPACE);
    expect(headers['X-Sandbox-Port']).toBe('8888');
    expect(headers['X-Sandbox-Pod-IP']).toBe('10.0.0.5');
    expect(headers['X-Request-ID']).toEqual(expect.any(String));
    expect(Number(headers['X-Sandbox-Timeout'])).toBeGreaterThan(0);
    // Multipart Content-Type is set by fetch, not by us.
    expect(headers['Content-Type']).toBeUndefined();
  });

  it.each(['', '.', '..', 'dir/script.py', 'a/b'])(
    'rejects the non-plain filename %p before any I/O',
    async (path) => {
      const {client, api, fetchFn} = setup();

      await expect(client.write(path, 'x')).rejects.toThrow(
        'expected a plain filename',
      );
      expect(api.createNamespacedCustomObject).not.toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it('retries transient failures (503, network error) then succeeds', async () => {
    vi.useFakeTimers();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(fetchResponse({status: 503}))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(fetchResponse({status: 200}));
    const {client} = setup({fetchFn});

    await withTimers(client.write('script.py', 'code'));

    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('throws SandboxInfrastructureError on a non-retryable 4xx', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse({status: 400}));
    const {client} = setup({fetchFn});

    await expect(client.write('script.py', 'code')).rejects.toBeInstanceOf(
      SandboxInfrastructureError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('throws SandboxInfrastructureError after exhausting retries', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn().mockRejectedValue(new Error('down'));
    const {client} = setup({fetchFn});

    await withTimers(
      expect(client.write('script.py', 'code')).rejects.toThrow(
        'failed after 6 attempts',
      ),
    );
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it('times out mid-retry when the per-request budget is exhausted', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse({status: 503}));
    const {client} = setup({fetchFn, timeoutSeconds: 1});

    await withTimers(
      expect(client.write('script.py', 'code')).rejects.toBeInstanceOf(
        SandboxTimeoutError,
      ),
    );
  });

  it.each([
    ['a 3xx status', {status: 302}],
    ['an opaqueredirect', {status: 0, type: 'opaqueredirect'}],
  ])('rejects %s as an infrastructure error', async (_label, response) => {
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse(response));
    const {client} = setup({fetchFn});

    await expect(client.write('script.py', 'code')).rejects.toThrow(
      'unexpected redirect',
    );
  });
});

describe('AgentSandboxClient.run', () => {
  it('executes the command and returns parsed stdout/stderr', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        fetchResponse({body: {stdout: 'hello', stderr: 'warn', exit_code: 0}}),
      );
    const {client} = setup({fetchFn});

    const result = await client.run('python3 script.py');

    expect(result).toEqual({stdout: 'hello', stderr: 'warn'});
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://10.0.0.1/execute');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({command: 'python3 script.py'});
  });

  it('defaults missing stdout/stderr to empty strings', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse({body: {}}));
    const {client} = setup({fetchFn});

    expect(await client.run('cmd')).toEqual({stdout: '', stderr: ''});
  });

  it('does not retry (single attempt) on a retryable status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse({status: 503}));
    const {client} = setup({fetchFn});

    await expect(client.run('cmd')).rejects.toBeInstanceOf(
      SandboxInfrastructureError,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('maps an aborted request to SandboxTimeoutError', async () => {
    const timeoutError = Object.assign(new Error('timed out'), {
      name: 'TimeoutError',
    });
    const fetchFn = vi.fn().mockRejectedValue(timeoutError);
    const {client} = setup({fetchFn});

    await expect(client.run('cmd')).rejects.toBeInstanceOf(SandboxTimeoutError);
  });
});

describe('AgentSandboxClient provisioning', () => {
  it('wraps a template lookup failure (non-Error) as infrastructure error', async () => {
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

  it('wraps a sandbox creation failure as infrastructure error', async () => {
    const api = happyApi();
    api.createNamespacedCustomObject.mockRejectedValue(new Error('quota'));
    const {client} = setup({api});

    await expect(client.run('cmd')).rejects.toThrow(
      'Failed to create Sandbox: quota',
    );
  });

  it('rejects a template missing spec.podTemplate', async () => {
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
      if (plural === 'sandboxes') return Promise.resolve(readySandbox());
      return Promise.resolve(gatewayWith('10.0.0.1'));
    });
    const {client} = setup({api});

    await client.write('script.py', 'x');

    const createArg = api.createNamespacedCustomObject.mock.calls[0][0];
    expect('volumeClaimTemplates' in createArg.body.spec).toBe(false);
  });

  it('throws when the created sandbox has no name', async () => {
    const api = happyApi();
    api.createNamespacedCustomObject.mockResolvedValue({metadata: {}});
    const {client} = setup({api});

    await expect(client.run('cmd')).rejects.toThrow(
      'Failed to create Sandbox: created Sandbox has no name',
    );
  });

  it('memoizes provisioning across write and run', async () => {
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
      .mockImplementationOnce(() => Promise.resolve(TEMPLATE)) // template
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
        : Promise.reject(Object.assign(new Error('gone'), {code: 404})),
    );
    const {client} = setup({api});

    await expect(client.run('cmd')).rejects.toThrow(
      'was deleted before becoming ready',
    );
  });

  it('wraps a non-404 readiness read error', async () => {
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) =>
      plural === 'sandboxtemplates'
        ? Promise.resolve(TEMPLATE)
        : Promise.reject(Object.assign(new Error('boom'), {code: 500})),
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
      if (plural === 'sandboxtemplates') return Promise.resolve(TEMPLATE);
      if (plural === 'sandboxes') {
        return Promise.resolve({
          metadata: {name: CREATED_NAME},
          status: {conditions: [{type: 'Ready', status: 'True'}], podIPs},
        });
      }
      return Promise.resolve(gatewayWith('10.0.0.1'));
    });
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse());
    const {client} = setup({api, fetchFn});

    await client.write('script.py', 'x');

    expect(
      fetchFn.mock.calls[0][1].headers['X-Sandbox-Pod-IP'],
    ).toBeUndefined();
  });
});

describe('AgentSandboxClient endpoint discovery', () => {
  it('brackets an IPv6 gateway address', async () => {
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) => {
      if (plural === 'sandboxtemplates') return Promise.resolve(TEMPLATE);
      if (plural === 'sandboxes') return Promise.resolve(readySandbox());
      return Promise.resolve(gatewayWith('2001:db8::1'));
    });
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse());
    const {client} = setup({api, fetchFn});

    await client.write('script.py', 'x');

    expect(fetchFn.mock.calls[0][0]).toBe('http://[2001:db8::1]/upload');
  });

  it('rejects unsafe addresses and keeps polling until a valid one appears', async () => {
    vi.useFakeTimers();
    const badAddresses = ['1.2.3.4/evil', 'bad_host', 'a'.repeat(254)];
    const api = happyApi();
    let gatewayCall = 0;
    api.getNamespacedCustomObject.mockImplementation(({plural}) => {
      if (plural === 'sandboxtemplates') return Promise.resolve(TEMPLATE);
      if (plural === 'sandboxes') return Promise.resolve(readySandbox());
      const address = badAddresses[gatewayCall] ?? 'good.example.com';
      gatewayCall++;
      return Promise.resolve(gatewayWith(address));
    });
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse());
    const {client} = setup({api, fetchFn});

    await withTimers(client.write('script.py', 'x'));

    expect(fetchFn.mock.calls[0][0]).toBe('http://good.example.com/upload');
  });

  it('times out when the gateway never reports a valid address', async () => {
    vi.useFakeTimers();
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) => {
      if (plural === 'sandboxtemplates') return Promise.resolve(TEMPLATE);
      if (plural === 'sandboxes') return Promise.resolve(readySandbox());
      return Promise.resolve(gatewayWith(undefined));
    });
    const {client} = setup({api, timeoutSeconds: 1});

    await withTimers(
      expect(client.run('cmd')).rejects.toThrow(
        'did not report a valid address',
      ),
    );
  });

  it('reports a missing gateway as an infrastructure error', async () => {
    vi.useFakeTimers();
    const api = happyApi();
    api.getNamespacedCustomObject.mockImplementation(({plural}) => {
      if (plural === 'sandboxtemplates') return Promise.resolve(TEMPLATE);
      if (plural === 'sandboxes') return Promise.resolve(readySandbox());
      return Promise.reject(Object.assign(new Error('nope'), {code: 404}));
    });
    const {client} = setup({api, timeoutSeconds: 1});

    await withTimers(
      expect(client.run('cmd')).rejects.toThrow(
        'Gateway "my-gateway" not found',
      ),
    );
  });

  it('uses an explicit apiUrl and skips gateway discovery', async () => {
    const api = happyApi();
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse());
    const {client} = setup({
      api,
      gatewayName: undefined,
      apiUrl: 'https://router.example:9000',
      fetchFn,
    });

    await client.write('script.py', 'x');

    expect(fetchFn.mock.calls[0][0]).toBe('https://router.example:9000/upload');
    const gatewayReads = api.getNamespacedCustomObject.mock.calls.filter(
      ([arg]) => arg.plural === 'gateways',
    );
    expect(gatewayReads).toHaveLength(0);
  });

  it('falls back to the in-cluster service address', async () => {
    const api = happyApi();
    const fetchFn = vi.fn().mockResolvedValue(fetchResponse());
    const {client} = setup({
      api,
      gatewayName: undefined,
      serverPort: 9999,
      fetchFn,
    });

    await client.write('script.py', 'x');

    expect(fetchFn.mock.calls[0][0]).toBe(
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

  it('is a no-op when never provisioned', async () => {
    const {client, api} = setup();

    await client.close();

    expect(api.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('treats a 404 on delete as success', async () => {
    const api = happyApi();
    api.deleteNamespacedCustomObject.mockRejectedValue(
      Object.assign(new Error('gone'), {code: 404}),
    );
    const {client} = setup({api});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await client.write('script.py', 'x');
    await expect(client.close()).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('logs but does not throw on other delete errors', async () => {
    const api = happyApi();
    api.deleteNamespacedCustomObject.mockRejectedValue(new Error('boom'));
    const {client} = setup({api});

    await client.write('script.py', 'x');
    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe('config loading', () => {
  it('uses in-cluster config when available', async () => {
    kubeConfigMock.loadFromCluster.mockReturnValue(undefined);
    kubeConfigMock.makeApiClient.mockReturnValue(happyApi());
    const client = new AgentSandboxClient({
      namespace: NAMESPACE,
      gatewayName: GATEWAY,
      fetchFn: vi
        .fn()
        .mockResolvedValue(fetchResponse()) as unknown as typeof fetch,
    });

    await client.write('script.py', 'x');

    expect(kubeConfigMock.loadFromCluster).toHaveBeenCalledTimes(1);
    expect(kubeConfigMock.loadFromDefault).not.toHaveBeenCalled();
  });

  it('falls back to the local kubeconfig', async () => {
    kubeConfigMock.loadFromCluster.mockImplementation(() => {
      throw new Error('not in cluster');
    });
    kubeConfigMock.loadFromDefault.mockReturnValue(undefined);
    kubeConfigMock.makeApiClient.mockReturnValue(happyApi());
    const client = new AgentSandboxClient({
      namespace: NAMESPACE,
      gatewayName: GATEWAY,
      fetchFn: vi
        .fn()
        .mockResolvedValue(fetchResponse()) as unknown as typeof fetch,
    });

    await client.write('script.py', 'x');

    expect(kubeConfigMock.loadFromCluster).toHaveBeenCalledTimes(1);
    expect(kubeConfigMock.loadFromDefault).toHaveBeenCalledTimes(1);
  });

  it('throws SandboxInfrastructureError when no config can be loaded', async () => {
    kubeConfigMock.loadFromCluster.mockImplementation(() => {
      throw new Error('not in cluster');
    });
    kubeConfigMock.loadFromDefault.mockImplementation(() => {
      throw new Error('no kubeconfig');
    });
    const client = new AgentSandboxClient({
      namespace: NAMESPACE,
      gatewayName: GATEWAY,
    });

    await expect(client.run('cmd')).rejects.toThrow(
      'Failed to load Kubernetes configuration',
    );
  });
});

describe('defaultSandboxClientFactory', () => {
  it('builds an AgentSandboxClient from options', () => {
    const client = defaultSandboxClientFactory({
      namespace: NAMESPACE,
      templateName: 'python-sandbox-template',
      gatewayName: GATEWAY,
    });
    expect(client).toBeInstanceOf(AgentSandboxClient);
  });
});
