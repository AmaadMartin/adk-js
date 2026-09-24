/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Collects the spans a test produces, in memory.
 *
 * The context manager is part of the harness rather than an extra: without it
 * `context.with()` does not survive an `await`, so a scope published for a
 * tool call is invisible to the code running inside it.
 */

import {context, trace} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {expect} from 'vitest';

/** A running in-memory tracing setup. */
export interface InMemoryTracing {
  /** The spans finished so far, oldest first. */
  spans(): ReadableSpan[];
  /** The single span finished so far. Fails when there is not exactly one. */
  onlySpan(): ReadableSpan;
  /** Forgets every span collected so far. */
  reset(): void;
  /** Shuts the provider down and restores the global tracing state. */
  shutdown(): Promise<void>;
}

/** Registers an in-memory tracer provider and context manager globally. */
export function startInMemoryTracing(): InMemoryTracing {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);

  return {
    spans: () => exporter.getFinishedSpans(),
    onlySpan: () => {
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      return spans[0];
    },
    reset: () => exporter.reset(),
    shutdown: async () => {
      await provider.shutdown();
      contextManager.disable();
      context.disable();
      trace.disable();
    },
  };
}

/** The `adk.experimental.*` attributes a span carries. */
export function experimentalAttributes(span: ReadableSpan): string[] {
  return Object.keys(span.attributes).filter((key) =>
    key.startsWith('adk.experimental'),
  );
}
