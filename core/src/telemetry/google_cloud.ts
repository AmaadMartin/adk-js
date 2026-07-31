/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {gcpDetector} from '@opentelemetry/resource-detector-gcp';
import {detectResources, Resource} from '@opentelemetry/resources';
import type {MetricReader} from '@opentelemetry/sdk-metrics';
import {PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import type {SpanProcessor} from '@opentelemetry/sdk-trace-base';
import {BatchSpanProcessor} from '@opentelemetry/sdk-trace-base';
import {GoogleAuth} from 'google-auth-library';

import {logger} from '../utils/logger.js';
import {loadOptionalDependency} from '../utils/optional_dependency_utils.js';

import {OtelExportersConfig, OTelHooks} from './setup.js';

const GCP_PROJECT_ERROR_MESSAGE =
  'Cannot determine GCP Project. OTel GCP Exporters cannot be set up. ' +
  'Please make sure to log into correct GCP Project.';

const METRIC_EXPORT_INTERVAL_MS = 5000;

async function getGcpProjectId(): Promise<string | undefined> {
  try {
    const auth = new GoogleAuth();
    const projectId = await auth.getProjectId();
    return projectId || undefined;
  } catch (_e: unknown) {
    return undefined;
  }
}

export async function getGcpExporters(
  config: OtelExportersConfig = {},
): Promise<OTelHooks> {
  const {
    enableTracing = false,
    enableMetrics = false,
    // enableCloudLogging = false,
  } = config;

  const projectId = await getGcpProjectId();
  if (!projectId) {
    logger.warn(GCP_PROJECT_ERROR_MESSAGE);
    return {};
  }

  const spanProcessors: SpanProcessor[] = [];
  if (enableTracing) {
    const {TraceExporter} = await loadOptionalDependency(
      () => import('@google-cloud/opentelemetry-cloud-trace-exporter'),
      {
        packageName: '@google-cloud/opentelemetry-cloud-trace-exporter',
        feature: 'Cloud Trace export (enableTracing)',
      },
    );
    spanProcessors.push(new BatchSpanProcessor(new TraceExporter({projectId})));
  }

  const metricReaders: MetricReader[] = [];
  if (enableMetrics) {
    const {MetricExporter} = await loadOptionalDependency(
      () => import('@google-cloud/opentelemetry-cloud-monitoring-exporter'),
      {
        packageName: '@google-cloud/opentelemetry-cloud-monitoring-exporter',
        feature: 'Cloud Monitoring export (enableMetrics)',
      },
    );
    metricReaders.push(
      new PeriodicExportingMetricReader({
        exporter: new MetricExporter({projectId}),
        exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
      }),
    );
  }

  return {spanProcessors, metricReaders, logRecordProcessors: []};
}

export function getGcpResource(): Resource {
  return detectResources({detectors: [gcpDetector]});
}
