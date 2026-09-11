/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Request-driven metric export
 * ../../../docs/guides/telemetry/agent_engine_metric_exporter/index.md
 *
 * Exports this workflow's metrics from the request lifecycle instead of a
 * background timer, which is what an agent on the Vertex AI Agent Runtime
 * needs: that runtime throttles CPU the instant a request finishes, so a timer
 * between requests never runs.
 *
 * The node brackets its own work with the two hooks. A server would call them
 * from request middleware instead, which is the only difference.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/telemetry/agent_engine_metric_exporter/agent.ts
 *
 * Send a turn. `ConsoleMetricExporter` prints the `turns` counter after each
 * one, and prints nothing at all while you sit at the prompt.
 */

import {
  buildRequestDrivenMetrics,
  maybeSetOtelProviders,
  node,
  NodeContext,
  Workflow,
} from '@google/adk';
import {metrics} from '@opentelemetry/api';
import {ConsoleMetricExporter} from '@opentelemetry/sdk-metrics';

const {reader, spanProcessor} = buildRequestDrivenMetrics(
  new ConsoleMetricExporter(),
  {
    // The defaults are 60s and 5s. Shortened so a handful of turns typed by
    // hand each produce an export.
    exportIntervalMillis: 10_000,
    floorMillis: 1_000,
  },
);

// The span processor drives point 4: it collects off `call_llm` span starts,
// so a single very long request still exports while it runs.
maybeSetOtelProviders([
  {metricReaders: [reader], spanProcessors: [spanProcessor]},
]);

const turns = metrics.getMeter('sample').createCounter('turns');

const shoutNode = node(
  async (_ctx: NodeContext, nodeInput: string) => {
    if (reader.noteRequestStart()) {
      // Fire and forget: a collect must not delay the work.
      void reader.submitCollect();
    }
    try {
      turns.add(1);
      return nodeInput.trim().toUpperCase();
    } finally {
      // Awaited, so the export completes before the runtime throttles the
      // process.
      if (reader.noteRequestEnd()) {
        await reader.submitCollect();
      }
    }
  },
  {name: 'shout_node'},
);

export const rootAgent = new Workflow({
  name: 'request_driven_metrics_workflow',
  edges: [['START', shoutNode]],
});
