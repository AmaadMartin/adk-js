/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Google Cloud metric exporter, in its own module.
 *
 * Two modules build this exporter: `./google_cloud.js` wraps it in a periodic
 * reader, and `./agent_engine.js` wraps it in the request-driven reader. Those
 * two also refer to each other, so the shared loader lives here to keep the
 * import graph acyclic.
 */

import {PushMetricExporter} from '@opentelemetry/sdk-metrics';

import {loadOptionalPeer} from '../utils/optional_peer.js';

/**
 * Builds the Cloud Monitoring metric exporter, loading its peer on demand.
 *
 * @param projectId The project to write metrics to. When omitted, the exporter
 *   infers it from the credentials or the GCP environment.
 * @throws If the optional peer dependency is not installed.
 */
export async function createGcpMetricExporter(
  projectId?: string,
): Promise<PushMetricExporter> {
  const {MetricExporter} = await loadOptionalPeer(
    {
      packageName: '@google-cloud/opentelemetry-cloud-monitoring-exporter',
      feature: 'getGcpExporters({enableMetrics: true})',
    },
    () => import('@google-cloud/opentelemetry-cloud-monitoring-exporter'),
  );
  return new MetricExporter({projectId});
}
