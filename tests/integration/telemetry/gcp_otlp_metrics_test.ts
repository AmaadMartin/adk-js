/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getGcpExporters} from '@google/adk';
import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import {GoogleAuth, OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';

// Application Default Credentials are the only ambient input stubbed here: the
// OTLP gRPC exporter and the metric reader are the real packages, so this test
// proves they compose.
vi.mock('google-auth-library');

describe('GCP OTLP metric export', () => {
  let authClient: OAuth2Client;

  beforeEach(() => {
    vi.clearAllMocks();
    authClient = new OAuth2Client();
    vi.mocked(GoogleAuth.prototype.getProjectId).mockImplementation(() =>
      Promise.resolve('test-project'),
    );
    vi.mocked(GoogleAuth.prototype.getClient).mockResolvedValue(authClient);
    vi.mocked(authClient.getRequestHeaders).mockResolvedValue(
      new Headers({authorization: 'Bearer test-token'}),
    );
  });

  it('installs a periodic reader over the real OTLP exporter', async () => {
    const hooks = await getGcpExporters({
      enableTracing: false,
      enableMetrics: true,
    });

    expect(hooks.spanProcessors).toEqual([]);
    expect(hooks.metricReaders).toHaveLength(1);
    const reader = hooks.metricReaders?.[0];
    expect(reader).toBeInstanceOf(PeriodicExportingMetricReader);

    try {
      // Nothing may be exported before a MeterProvider drains the reader, so no
      // credential is minted and no gRPC channel is opened.
      expect(authClient.getRequestHeaders).not.toHaveBeenCalled();
    } finally {
      // Releases the 5s export timer so it cannot outlive this test.
      await reader?.shutdown();
    }
  });
});
