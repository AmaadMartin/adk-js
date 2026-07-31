/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getArtifactServiceFromUri, getGcpExporters} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

// Mock the three optional GCP packages to simulate them not being installed.
vi.mock('@google-cloud/storage', () => {
  throw new Error("Cannot find module '@google-cloud/storage'");
});
vi.mock('@google-cloud/opentelemetry-cloud-trace-exporter', () => {
  throw new Error(
    "Cannot find module '@google-cloud/opentelemetry-cloud-trace-exporter'",
  );
});
vi.mock('@google-cloud/opentelemetry-cloud-monitoring-exporter', () => {
  throw new Error(
    "Cannot find module '@google-cloud/opentelemetry-cloud-monitoring-exporter'",
  );
});

// getGcpExporters short-circuits to {} without a resolvable project id, which
// would make the rejection assertions below pass vacuously on a runner with no
// credentials.
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getProjectId(): Promise<string> {
      return 'test-project';
    }
  },
}));

// Vitest wraps a throwing mock factory, so `error.code` never reaches the
// helper and the actionable message is not produced here. The message itself is
// covered by core/test/utils/optional_dependency_utils_test.ts.
const MOCK_FAILURE = /There was an error when mocking a module/;

const artifactRequest = {
  appName: 'test-app',
  userId: 'test-user',
  sessionId: 'test-session',
  filename: 'test.txt',
};

describe('Lazy load optional GCP dependencies', () => {
  it('constructs a GCS artifact service without resolving the SDK', () => {
    expect(() => getArtifactServiceFromUri('gs://test-bucket')).not.toThrow();
  });

  it('rejects listVersions when @google-cloud/storage is missing', async () => {
    const service = getArtifactServiceFromUri('gs://test-bucket');

    await expect(service.listVersions(artifactRequest)).rejects.toThrow(
      MOCK_FAILURE,
    );
  });

  it('rejects loadArtifact instead of swallowing the failure into undefined', async () => {
    const service = getArtifactServiceFromUri('gs://test-bucket');

    await expect(service.loadArtifact(artifactRequest)).rejects.toThrow(
      MOCK_FAILURE,
    );
  });

  it('rejects getArtifactVersion instead of swallowing the failure into undefined', async () => {
    const service = getArtifactServiceFromUri('gs://test-bucket');

    await expect(service.getArtifactVersion(artifactRequest)).rejects.toThrow(
      MOCK_FAILURE,
    );
  });

  it('rejects when the trace exporter is missing and enableTracing is set', async () => {
    await expect(getGcpExporters({enableTracing: true})).rejects.toThrow(
      MOCK_FAILURE,
    );
  });

  it('rejects when the monitoring exporter is missing and enableMetrics is set', async () => {
    await expect(getGcpExporters({enableMetrics: true})).rejects.toThrow(
      MOCK_FAILURE,
    );
  });

  it('resolves with no exporters when both flags are disabled', async () => {
    await expect(
      getGcpExporters({enableTracing: false, enableMetrics: false}),
    ).resolves.toEqual({
      spanProcessors: [],
      metricReaders: [],
      logRecordProcessors: [],
    });
  });
});
