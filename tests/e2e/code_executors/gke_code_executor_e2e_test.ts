/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hermetic end-to-end test for {@link GkeCodeExecutor}.
 *
 * Unlike the unit suite (which injects stub API clients), this test exercises
 * the full stack with **no mocks**: a real local HTTP server stands in for the
 * Kubernetes API and the executor drives it through the real
 * `@kubernetes/client-node` library. It therefore proves that the manifest is
 * serialized correctly, the requests are shaped correctly, and the responses
 * are parsed correctly against the real client — everything a live GKE cluster
 * would do except the actual sandboxed execution.
 */

import {IncomingMessage, Server, ServerResponse, createServer} from 'node:http';
import {AddressInfo} from 'node:net';

import {
  CodeExecutionLanguage,
  GkeCodeExecutor,
  InvocationContext,
} from '@google/adk';
import {BatchV1Api, CoreV1Api, KubeConfig} from '@kubernetes/client-node';
import {afterEach, describe, expect, it} from 'vitest';

const NAMESPACE = 'agents';

interface FakeApiServerOptions {
  jobStatus: Record<string, unknown>;
  podLog: string;
}

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

/**
 * A minimal in-process HTTP server implementing the Kubernetes REST endpoints
 * that {@link GkeCodeExecutor} calls. It records every request so tests can
 * assert on the payloads the real client actually transmitted.
 */
class FakeK8sApiServer {
  readonly requests: RecordedRequest[] = [];
  private server!: Server;

  constructor(private readonly options: FakeApiServerOptions) {}

  async start(): Promise<number> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
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

      // Pod log endpoint returns plain text.
      if (method === 'GET' && url.includes('/pods/') && url.includes('/log')) {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end(this.options.podLog);
        return;
      }

      const json = (status: number, body: unknown) => {
        res.writeHead(status, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(body));
      };

      // List pods for the Job.
      if (method === 'GET' && url.includes('/pods')) {
        json(200, {items: [{metadata: {name: 'pod-1'}}]});
        return;
      }
      // Read the Job status.
      if (method === 'GET' && url.includes('/jobs/')) {
        json(200, {status: this.options.jobStatus});
        return;
      }
      // Create the Job.
      if (method === 'POST' && url.includes('/jobs')) {
        json(201, {
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: {name: 'adk-exec-e2e', uid: 'uid-e2e'},
        });
        return;
      }
      // Create or patch the ConfigMap.
      json(method === 'POST' ? 201 : 200, {kind: 'ConfigMap'});
    });
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildRealClients(port: number): {
  batchApi: BatchV1Api;
  coreApi: CoreV1Api;
} {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [
      {name: 'e2e', server: `http://127.0.0.1:${port}`, skipTLSVerify: true},
    ],
    users: [{name: 'e2e', token: 'e2e-token'}],
    contexts: [{name: 'e2e', cluster: 'e2e', user: 'e2e'}],
    currentContext: 'e2e',
  });
  return {
    batchApi: kc.makeApiClient(BatchV1Api),
    coreApi: kc.makeApiClient(CoreV1Api),
  };
}

const INVOCATION_CONTEXT = {
  invocationId: 'e2e-invocation',
} as unknown as InvocationContext;

describe('GkeCodeExecutor (e2e, real client)', () => {
  let server: FakeK8sApiServer;

  afterEach(async () => {
    await server.stop();
  });

  it('runs a Job to completion and returns its Pod logs as stdout', async () => {
    server = new FakeK8sApiServer({
      jobStatus: {succeeded: 1},
      podLog: 'hello world',
    });
    const port = await server.start();
    const {batchApi, coreApi} = buildRealClients(port);
    const executor = new GkeCodeExecutor({
      namespace: NAMESPACE,
      batchApi,
      coreApi,
    });

    const result = await executor.executeCode({
      invocationContext: INVOCATION_CONTEXT,
      codeExecutionInput: {
        code: 'print("hello world")',
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    });

    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('');
    expect(result.outputFiles).toEqual([]);

    // The real client transmitted a hardened Job manifest over the wire.
    const jobPost = server.requests.find(
      (r) => r.method === 'POST' && r.url.includes('/jobs'),
    );
    const jobBody = jobPost?.body as {
      spec: {
        backoffLimit: number;
        template: {
          spec: {
            runtimeClassName: string;
            containers: Array<{
              command: string[];
              securityContext: Record<string, unknown>;
            }>;
          };
        };
      };
    };
    expect(jobBody.spec.backoffLimit).toBe(0);
    expect(jobBody.spec.template.spec.runtimeClassName).toBe('gvisor');
    const container = jobBody.spec.template.spec.containers[0];
    expect(container.command).toEqual(['python3', '/app/code.py']);
    expect(container.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1001,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: {drop: ['ALL']},
    });

    // The ConfigMap was patched with an owner reference to the Job.
    const patch = server.requests.find((r) => r.method === 'PATCH');
    const patchBody = patch?.body as {
      metadata: {ownerReferences: Array<{uid: string; controller: boolean}>};
    };
    expect(patchBody.metadata.ownerReferences[0].uid).toBe('uid-e2e');
    expect(patchBody.metadata.ownerReferences[0].controller).toBe(true);
  });

  it('returns the Pod logs as stderr when the Job fails', async () => {
    server = new FakeK8sApiServer({
      jobStatus: {failed: 1},
      podLog: 'Traceback...\nValueError: boom',
    });
    const port = await server.start();
    const {batchApi, coreApi} = buildRealClients(port);
    const executor = new GkeCodeExecutor({
      namespace: NAMESPACE,
      batchApi,
      coreApi,
    });

    const result = await executor.executeCode({
      invocationContext: INVOCATION_CONTEXT,
      codeExecutionInput: {
        code: 'raise ValueError("boom")',
        language: CodeExecutionLanguage.PYTHON,
        inputFiles: [],
      },
    });

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Job failed. Logs:');
    expect(result.stderr).toContain('ValueError: boom');
  });
});
