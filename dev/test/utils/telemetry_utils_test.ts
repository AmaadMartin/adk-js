/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getGcpExporters,
  getGcpResource,
  maybeSetOtelProviders,
} from '@google/adk';
import {emptyResource} from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {GoogleAuth, OAuth2Client} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {setupTelemetry} from '../../src/utils/telemetry_utils.js';

vi.mock('@google/adk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/adk')>()),
  getGcpExporters: vi.fn(() => Promise.resolve({})),
  getGcpResource: vi.fn(() => emptyResource()),
  maybeSetOtelProviders: vi.fn(),
}));

const PROJECT_ID = 'dev-project';

describe('setupTelemetry with --otel_to_cloud', () => {
  beforeEach(() => {
    vi.stubEnv('GCLOUD_PROJECT', undefined);
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', PROJECT_ID);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('should resolve the credentials once and pass them to both calls', async () => {
    const authClient = new OAuth2Client();
    const getClient = vi
      .spyOn(GoogleAuth.prototype, 'getClient')
      .mockResolvedValue(authClient);

    await setupTelemetry(true);

    expect(getClient).toHaveBeenCalledTimes(1);
    expect(getGcpExporters).toHaveBeenCalledWith({
      enableTracing: true,
      enableMetrics: true,
      enableLogging: true,
      googleAuth: {authClient, projectId: PROJECT_ID},
    });
    expect(getGcpResource).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('should install the internal span processors alongside the GCP ones', async () => {
    vi.spyOn(GoogleAuth.prototype, 'getClient').mockResolvedValue(
      new OAuth2Client(),
    );
    const internal = new BatchSpanProcessor(new InMemorySpanExporter());

    await setupTelemetry(true, [internal]);

    expect(maybeSetOtelProviders).toHaveBeenCalledWith(
      [{spanProcessors: [internal]}, {}],
      expect.anything(),
    );
    await internal.shutdown();
  });

  it('should degrade instead of throwing when the credentials are missing', async () => {
    vi.spyOn(GoogleAuth.prototype, 'getClient').mockRejectedValue(
      new Error('Could not load the default credentials'),
    );

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
