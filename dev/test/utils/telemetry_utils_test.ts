/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {metrics, trace} from '@opentelemetry/api';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {shutdownTelemetry} from '../../src/utils/telemetry_utils.js';

/** A meter provider that records its teardown, shaped like the SDK one. */
function stubMeterProvider() {
  return {getMeter: () => metrics.getMeter('test'), shutdown: vi.fn()};
}

/** A tracer provider reachable only through a proxy, as the API returns it. */
function stubTracerProxy() {
  const delegate = {
    getTracer: () => trace.getTracer('test'),
    shutdown: vi.fn(),
  };
  return {getTracer: delegate.getTracer, getDelegate: () => delegate, delegate};
}

describe('shutdownTelemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('flushes the tracer provider behind the API proxy', async () => {
    const proxy = stubTracerProxy();
    vi.spyOn(trace, 'getTracerProvider').mockReturnValue(proxy);

    await shutdownTelemetry();

    expect(proxy.delegate.shutdown).toHaveBeenCalledTimes(1);
  });

  it('flushes a meter provider the global registry returns directly', async () => {
    const meterProvider = stubMeterProvider();
    vi.spyOn(metrics, 'getMeterProvider').mockReturnValue(meterProvider);

    await shutdownTelemetry();

    expect(meterProvider.shutdown).toHaveBeenCalledTimes(1);
  });

  it('flushes both providers', async () => {
    const proxy = stubTracerProxy();
    const meterProvider = stubMeterProvider();
    vi.spyOn(trace, 'getTracerProvider').mockReturnValue(proxy);
    vi.spyOn(metrics, 'getMeterProvider').mockReturnValue(meterProvider);

    await shutdownTelemetry();

    expect(proxy.delegate.shutdown).toHaveBeenCalledTimes(1);
    expect(meterProvider.shutdown).toHaveBeenCalledTimes(1);
  });

  it('does nothing when only the noop providers are registered', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
