/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives the Agent Engine metric middleware through a real HTTP request.
 *
 * The server, its Express stack, the reader and the OpenTelemetry SDK are all
 * real. Only the two exporters that need credentials and a network are stubbed.
 */

import {
  clearAgentEngineMetricsSetupCache,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
} from '@google/adk';
import {metrics, trace} from '@opentelemetry/api';
import {ExportResult} from '@opentelemetry/core';
import {PushMetricExporter, ResourceMetrics} from '@opentelemetry/sdk-metrics';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {AgentLoader} from '../../src/utils/agent_loader.js';

const AGENT_ENGINE_ID_ENV_VAR = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

const {batches} = vi.hoisted(() => ({batches: [] as ResourceMetrics[]}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getProjectId(): Promise<string> {
      return Promise.resolve('test-project');
    }
  },
}));

/** Records every batch the reader exports, so a test can count collects. */
vi.mock('../../../core/src/telemetry/gcp_metric_exporter.js', async () => {
  const {ExportResultCode} = await import('@opentelemetry/core');
  return {
    createGcpMetricExporter: () =>
      Promise.resolve({
        export(
          resourceMetrics: ResourceMetrics,
          resultCallback: (result: ExportResult) => void,
        ): void {
          batches.push(resourceMetrics);
          resultCallback({code: ExportResultCode.SUCCESS});
        },
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      } satisfies PushMetricExporter),
  };
});

vi.mock('@google-cloud/opentelemetry-cloud-trace-exporter', async () => {
  const {ExportResultCode} = await import('@opentelemetry/core');
  return {
    TraceExporter: class {
      export(_spans: unknown[], done: (result: ExportResult) => void): void {
        done({code: ExportResultCode.SUCCESS});
      }
      forceFlush(): Promise<void> {
        return Promise.resolve();
      }
      shutdown(): Promise<void> {
        return Promise.resolve();
      }
    },
  };
});

/** Serves no agent: these tests only exercise the request path. */
class EmptyAgentLoader extends AgentLoader {
  override listAgents(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

async function startServer(otelToCloud: boolean): Promise<AdkApiServer> {
  const server = new AdkApiServer({
    agentLoader: new EmptyAgentLoader(),
    sessionService: new InMemorySessionService(),
    memoryService: new InMemoryMemoryService(),
    artifactService: new InMemoryArtifactService(),
    otelToCloud,
  });
  await server.start();
  return server;
}

describe('Agent Engine request metrics', () => {
  let server: AdkApiServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    batches.length = 0;
    clearAgentEngineMetricsSetupCache();
    metrics.disable();
    trace.disable();
    vi.unstubAllEnvs();
  });

  it('exports a metric point on the request path', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');
    server = await startServer(true);
    metrics
      .getMeter('adk_api_server_agent_engine_test')
      .createCounter('requests')
      .add(1);

    const response = await fetch(`${server.url}/health`);

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(batches.length).toBeGreaterThan(0));
  });

  it('exports nothing off Agent Engine', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, undefined);
    server = await startServer(true);

    const response = await fetch(`${server.url}/health`);

    expect(response.status).toBe(200);
    expect(batches).toHaveLength(0);
  });

  it('exports nothing when telemetry does not go to Google Cloud', async () => {
    vi.stubEnv(AGENT_ENGINE_ID_ENV_VAR, '123');
    server = await startServer(false);

    const response = await fetch(`${server.url}/health`);

    expect(response.status).toBe(200);
    expect(batches).toHaveLength(0);
  });
});
