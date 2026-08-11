/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {metrics, trace} from '@opentelemetry/api';
import {createServer, Server} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runAgent} from '../../../dev/src/cli/cli_run.js';

const AGENT_PATH = 'tests/integration/cli/test_agents/otel_run_agent.ts';
const INPUT_PATH = 'tests/integration/cli/test_agents/otel_run_input.json';

/** Long enough that only an explicit flush can deliver a span during a run. */
const BATCH_DELAY_MS = '60000';

const OTLP_ENDPOINT_VARS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
];

/** Collects the OTLP trace requests a run exports over real HTTP. */
class TraceCollector {
  readonly spanNames: string[] = [];
  private server?: Server;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.record(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, {'content-type': 'application/json'});
        res.end('{}');
      });
    });

    const server = this.server;
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const {port} = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1/traces`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private record(body: string): void {
    const payload = JSON.parse(body) as {
      resourceSpans: Array<{scopeSpans: Array<{spans: Array<{name: string}>}>}>;
    };
    for (const resourceSpan of payload.resourceSpans) {
      for (const scopeSpan of resourceSpan.scopeSpans) {
        this.spanNames.push(...scopeSpan.spans.map((span) => span.name));
      }
    }
  }
}

describe('adk run telemetry', () => {
  let collector: TraceCollector;

  beforeEach(() => {
    collector = new TraceCollector();
    for (const name of OTLP_ENDPOINT_VARS) {
      vi.stubEnv(name, undefined);
    }
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await collector.stop();
    // The providers a run registers outlive it, so reset the OTel globals.
    trace.disable();
    metrics.disable();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('exports the spans of a replayed run to the configured endpoint', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', await collector.start());
    vi.stubEnv('OTEL_BSP_SCHEDULE_DELAY', BATCH_DELAY_MS);

    await runAgent({agentPath: AGENT_PATH, inputFile: INPUT_PATH});

    expect(collector.spanNames).toContain('invocation');
  });

  it('records no span when no exporter is configured', async () => {
    await runAgent({agentPath: AGENT_PATH, inputFile: INPUT_PATH});

    const span = trace.getTracer('test').startSpan('probe');
    span.end();
    expect(span.isRecording()).toBe(false);
  });
});
