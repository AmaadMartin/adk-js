/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getGcpExporters,
  getGcpResource,
  maybeSetOtelProviders,
  ResolvedGoogleAuth,
  resolveGoogleAuth,
} from '@google/adk';
import {emptyResource} from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-base';
// `@google/adk` declares google-auth-library as a direct dependency, so this
// test-only import needs no dependency of its own.
import {OAuth2Client} from 'google-auth-library';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {setupTelemetry} from '../../src/utils/telemetry_utils.js';

vi.mock('@google/adk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/adk')>()),
  resolveGoogleAuth: vi.fn(),
  getGcpExporters: vi.fn(() => Promise.resolve({})),
  getGcpResource: vi.fn(() => emptyResource()),
  maybeSetOtelProviders: vi.fn(),
}));

const RESOLVED: ResolvedGoogleAuth = {
  authClient: new OAuth2Client(),
  projectId: 'dev-project',
};

describe('setupTelemetry with --otel_to_cloud', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('should resolve the credentials once and pass them to both calls', async () => {
    vi.mocked(resolveGoogleAuth).mockResolvedValue(RESOLVED);

    await setupTelemetry(true);

    expect(resolveGoogleAuth).toHaveBeenCalledTimes(1);
    expect(getGcpExporters).toHaveBeenCalledWith({
      enableTracing: true,
      enableMetrics: true,
      enableLogging: true,
      googleAuth: RESOLVED,
    });
    // The same project must reach the resource, or the log records and the
    // spans describe different projects on Agent Engine.
    expect(getGcpResource).toHaveBeenCalledWith(RESOLVED.projectId);
  });

  it('should install the internal span processors alongside the GCP ones', async () => {
    vi.mocked(resolveGoogleAuth).mockResolvedValue(RESOLVED);
    const internal = new BatchSpanProcessor(new InMemorySpanExporter());

    await setupTelemetry(true, [internal]);

    expect(maybeSetOtelProviders).toHaveBeenCalledWith(
      [{spanProcessors: [internal]}, {}],
      expect.anything(),
    );
    await internal.shutdown();
  });

  it('should degrade instead of throwing when the credentials are missing', async () => {
    vi.mocked(resolveGoogleAuth).mockResolvedValue(undefined);

    await expect(setupTelemetry(true)).resolves.toBeUndefined();

    expect(getGcpExporters).toHaveBeenCalledWith({
      enableTracing: true,
      enableMetrics: true,
      enableLogging: true,
      googleAuth: undefined,
    });
    expect(getGcpResource).toHaveBeenCalledWith(undefined);
  });
});
