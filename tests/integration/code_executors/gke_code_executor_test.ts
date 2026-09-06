/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for {@link GkeCodeExecutor} job mode.
 *
 * The unit suite injects fake API clients. This test injects none: a real HTTP
 * server on localhost stands in for the Kubernetes API, and the executor drives
 * the real `@kubernetes/client-node` clients and watch against it over a real
 * socket. It therefore proves that the Job manifest serializes, that the watch
 * stream parses, and that the responses deserialize against the real library.
 * It needs no cluster and no kubeconfig.
 */

import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {AddressInfo} from 'node:net';

import {
  CodeExecutionLanguage,
  GkeCodeExecutor,
  InvocationContext,
} from '@google/adk';
import {
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  V1JobStatus,
  Watch,
} from '@kubernetes/client-node';
import {afterEach, describe, expect, it} from 'vitest';

const NAMESPACE = 'agents';
const POD_NAME = 'pod-1';
const JOB_UID = 'uid-e2e';

interface FakeApiServerOptions {
  /** One array of Job statuses per watch connection, replayed in order. */
  watchConnections: V1JobStatus[][];
  podLog: string;
  /** Status the `code-runner` container reports, or none. */
  containerExitCode?: number;
  /** HTTP status the watch endpoint answers with. Defaults to 200. */
  watchStatus?: number;
}

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function podListBody(exitCode?: number) {
  const pod: Record<string, unknown> = {metadata: {name: POD_NAME}};
  if (exitCode !== undefined) {
    pod['status'] = {
      containerStatuses: [
        {name: 'code-runner', state: {terminated: {exitCode}}},
      ],
    };
  }
  return {items: [pod]};
}

/**
 * A minimal HTTP server implementing the Kubernetes endpoints
 * {@link GkeCodeExecutor} calls. It records every request so the test can
 * assert on what the real client transmitted.
 */
class FakeK8sApiServer {
  readonly requests: RecordedRequest[] = [];
  private server?: Server;
  private watchCall = 0;

  constructor(private readonly options: FakeApiServerOptions) {}

  async start(): Promise<number> {
    const server = createServer((req, res) => this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    return (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  /** How many watch connections the executor opened. */
  get watchConnectionCount(): number {
    return this.watchCall;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      const url = req.url ?? '';
      const method = req.method ?? 'GET';
      this.requests.push({
        method,
        url,
        body: raw ? safeJsonParse(raw) : undefined,
      });
      this.respond(method, url, res);
    });
  }

  private respond(method: string, url: string, res: ServerResponse): void {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(body));
    };

    if (method === 'GET' && url.includes('watch=true')) {
      this.streamWatch(res);
      return;
    }
    if (method === 'GET' && url.includes('/log')) {
      res.writeHead(200, {'Content-Type': 'text/plain'});
      res.end(this.options.podLog);
      return;
    }
    if (method === 'GET' && url.includes('/pods')) {
      json(200, podListBody(this.options.containerExitCode));
      return;
    }
    if (method === 'POST' && url.includes('/jobs')) {
      json(201, {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {name: 'adk-exec-e2e', uid: JOB_UID},
      });
      return;
    }
    json(method === 'POST' ? 201 : 200, {kind: 'ConfigMap'});
  }

  /** Streams one connection's worth of Job events, then closes it. */
  private streamWatch(res: ServerResponse): void {
    const connection = this.watchCall++;
    const watchStatus = this.options.watchStatus ?? 200;
    if (watchStatus !== 200) {
      res.writeHead(watchStatus, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({kind: 'Status', reason: 'Forbidden'}));
      return;
    }
    const statuses = this.options.watchConnections[connection] ?? [];
    res.writeHead(200, {'Content-Type': 'application/json'});
    for (const status of statuses) {
      res.write(`${JSON.stringify({type: 'MODIFIED', object: {status}})}\n`);
    }
    res.end();
  }
}

function buildRealClients(port: number) {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [
      {name: 'local', server: `http://127.0.0.1:${port}`, skipTLSVerify: true},
    ],
    users: [{name: 'local', token: 'local-token'}],
    contexts: [{name: 'local', cluster: 'local', user: 'local'}],
    currentContext: 'local',
  });
  return {
    jobs: kc.makeApiClient(BatchV1Api),
    pods: kc.makeApiClient(CoreV1Api),
    watcher: new Watch(kc),
  };
}

const INVOCATION_CONTEXT = {
  invocationId: 'integration-invocation',
} as Pick<InvocationContext, 'invocationId'> as InvocationContext;

function runCode(executor: GkeCodeExecutor, code: string) {
  return executor.executeCode({
    invocationContext: INVOCATION_CONTEXT,
    codeExecutionInput: {
      code,
      language: CodeExecutionLanguage.PYTHON,
      inputFiles: [],
    },
  });
}

describe('GkeCodeExecutor against a real Kubernetes API client', () => {
  let server: FakeK8sApiServer;

  async function startExecutor(options: FakeApiServerOptions) {
    server = new FakeK8sApiServer(options);
    const port = await server.start();
    return new GkeCodeExecutor({
      namespace: NAMESPACE,
      timeoutSeconds: 30,
      apiClients: buildRealClients(port),
    });
  }

  afterEach(async () => {
    await server.stop();
  });

  it('runs a Job to completion and returns its Pod log as stdout', async () => {
    const executor = await startExecutor({
      watchConnections: [[{succeeded: 1}]],
      podLog: 'hello world',
      containerExitCode: 0,
    });

    const result = await runCode(executor, 'print("hello world")');

    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.outputFiles).toEqual([]);

    const jobPost = server.requests.find(
      (r) => r.method === 'POST' && r.url.includes('/jobs'),
    );
    expect(jobPost?.url).toBe(`/apis/batch/v1/namespaces/${NAMESPACE}/jobs`);
    const jobBody = jobPost?.body;
    expect(jobBody).toMatchObject({
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 600,
        template: {
          spec: {
            runtimeClassName: 'gvisor',
            automountServiceAccountToken: false,
            containers: [
              {
                name: 'code-runner',
                command: ['python3', '/app/code.py'],
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: 1001,
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: {drop: ['ALL']},
                },
              },
            ],
          },
        },
      },
    });

    const patch = server.requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toMatchObject({
      metadata: {ownerReferences: [{uid: JOB_UID, controller: true}]},
    });
  });

  it('reports the container exit status of a failed Job', async () => {
    const executor = await startExecutor({
      watchConnections: [[{failed: 1}]],
      podLog: 'Traceback...\nValueError: boom',
      containerExitCode: 3,
    });

    const result = await runCode(executor, 'raise ValueError("boom")');

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Job failed. Logs:');
    expect(result.stderr).toContain('ValueError: boom');
    expect(result.exitCode).toBe(3);
  });

  it('re-establishes the watch when the server closes the stream early', async () => {
    const executor = await startExecutor({
      // The first connection reports the Job still running, then closes.
      watchConnections: [[{active: 1}], [{succeeded: 1}]],
      podLog: 'ready at last',
      containerExitCode: 0,
    });

    const result = await runCode(executor, 'print("ready at last")');

    expect(result.stdout).toBe('ready at last');
    expect(server.watchConnectionCount).toBe(2);
  });

  it('watches the Job by name with a field selector', async () => {
    const executor = await startExecutor({
      watchConnections: [[{succeeded: 1}]],
      podLog: '',
      containerExitCode: 0,
    });

    await runCode(executor, 'pass');

    const watch = server.requests.find((r) => r.url.includes('watch=true'));
    const query = new URL(`http://localhost${watch?.url}`).searchParams;
    expect(query.get('fieldSelector') ?? '').toMatch(
      /^metadata\.name=adk-exec-/,
    );
    expect(query.get('timeoutSeconds')).toBe('30');
  });

  it('reports a forbidden watch once, without reopening it', async () => {
    server = new FakeK8sApiServer({
      watchConnections: [],
      podLog: '',
      watchStatus: 403,
    });
    const port = await server.start();
    const executor = new GkeCodeExecutor({
      namespace: NAMESPACE,
      // Long enough that a watch reopened on failure would keep going well
      // past the assertions below.
      timeoutSeconds: 30,
      apiClients: buildRealClients(port),
    });

    const result = await runCode(executor, 'print("nope")');

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Kubernetes API error: Forbidden');
    expect(server.watchConnectionCount).toBe(1);
  });

  it('reports a Kubernetes API error as stderr', async () => {
    server = new FakeK8sApiServer({watchConnections: [], podLog: ''});
    const port = await server.start();
    // Nothing listens on this port, so creating the ConfigMap fails.
    await server.stop();
    const executor = new GkeCodeExecutor({
      namespace: NAMESPACE,
      timeoutSeconds: 5,
      apiClients: buildRealClients(port),
    });

    const result = await runCode(executor, 'print("nope")');

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('An unexpected executor error occurred');
  });
});
