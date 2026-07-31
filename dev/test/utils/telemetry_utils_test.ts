/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getGcpExporters,
  getGcpProjectId,
  getGcpResource,
  maybeSetOtelProviders,
} from '@google/adk';
import {Resource} from '@opentelemetry/resources';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {setupTelemetry} from '../../src/utils/telemetry_utils.js';

vi.mock('@google/adk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/adk')>()),
  getGcpExporters: vi.fn(),
  getGcpProjectId: vi.fn(),
  getGcpResource: vi.fn(),
  maybeSetOtelProviders: vi.fn(),
}));

describe('setupTelemetry with --otel_to_cloud', () => {
  let gcpResource: Resource;

  beforeEach(() => {
    vi.clearAllMocks();
    gcpResource = resourceStub();
    vi.mocked(getGcpExporters).mockResolvedValue({
      spanProcessors: [],
      metricReaders: [],
      logRecordProcessors: [],
    });
    vi.mocked(getGcpProjectId).mockResolvedValue('adc-project');
    vi.mocked(getGcpResource).mockReturnValue(gcpResource);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the resource with the project the Telemetry API routes on', async () => {
    await setupTelemetry(true);

    expect(getGcpProjectId).toHaveBeenCalledTimes(1);
    expect(getGcpResource).toHaveBeenCalledWith('adc-project');
    expect(maybeSetOtelProviders).toHaveBeenCalledWith(
      expect.anything(),
      gcpResource,
    );
  });

  it('still installs providers when the project cannot be resolved', async () => {
    vi.mocked(getGcpProjectId).mockResolvedValue(undefined);

    await setupTelemetry(true);

    expect(getGcpResource).toHaveBeenCalledWith(undefined);
    expect(maybeSetOtelProviders).toHaveBeenCalledTimes(1);
  });

  it('does not resolve a GCP project when cloud export is off', async () => {
    await setupTelemetry(false);

    expect(getGcpProjectId).not.toHaveBeenCalled();
    expect(getGcpExporters).not.toHaveBeenCalled();
  });
});

/** A minimal Resource double; only identity matters to these assertions. */
function resourceStub(): Resource {
  return {
    attributes: {},
    getRawAttributes: () => [],
    merge: () => resourceStub(),
  };
}
