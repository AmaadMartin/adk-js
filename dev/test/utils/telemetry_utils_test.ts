/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {metrics, ProxyTracerProvider, trace} from '@opentelemetry/api';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {shutdownTelemetry} from '../../src/utils/telemetry_utils.js';

/** A meter provider that records its teardown, shaped like the SDK one. */
function stubMeterProvider() {
  return {getMeter: () => metrics.getMeter('test'), shutdown: vi.fn()};
}

/** A real API proxy over a tracer provider, as `trace` hands one back. */
function stubTracerProxy() {
  const delegate = {
    getTracer: () => trace.getTracer('test'),
    shutdown: vi.fn(),
  };
  const proxy = new ProxyTracerProvider();
  proxy.setDelegate(delegate);
  return {proxy, delegate};
}

describe('shutdownTelemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('flushes the tracer provider behind the API proxy', async () => {
    const {proxy, delegate} = stubTracerProxy();
    vi.spyOn(trace, 'getTracerProvider').mockReturnValue(proxy);

    await shutdownTelemetry();

    expect(delegate.shutdown).toHaveBeenCalledTimes(1);
  });

  it('flushes a tracer provider the global registry returns unproxied', async () => {
    const tracerProvider = {
      getTracer: () => trace.getTracer('test'),
      shutdown: vi.fn(),
    };
    vi.spyOn(trace, 'getTracerProvider').mockReturnValue(tracerProvider);

    await shutdownTelemetry();

    expect(tracerProvider.shutdown).toHaveBeenCalledTimes(1);
  });

  it('flushes a meter provider the global registry returns directly', async () => {
    const meterProvider = stubMeterProvider();
    vi.spyOn(metrics, 'getMeterProvider').mockReturnValue(meterProvider);

    await shutdownTelemetry();

    expect(meterProvider.shutdown).toHaveBeenCalledTimes(1);
  });

  it('flushes both providers', async () => {
    const {proxy, delegate} = stubTracerProxy();
    const meterProvider = stubMeterProvider();
    vi.spyOn(trace, 'getTracerProvider').mockReturnValue(proxy);
    vi.spyOn(metrics, 'getMeterProvider').mockReturnValue(meterProvider);

    await shutdownTelemetry();

    expect(delegate.shutdown).toHaveBeenCalledTimes(1);
    expect(meterProvider.shutdown).toHaveBeenCalledTimes(1);
  });

  it('does nothing when only the noop providers are registered', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
