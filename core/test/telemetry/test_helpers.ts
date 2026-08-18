/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {metrics} from '@opentelemetry/api';
import {
  DataPoint,
  DataPointType,
  Histogram,
  HistogramMetricData,
  MeterProvider,
  MetricReader,
} from '@opentelemetry/sdk-metrics';
import {expect} from 'vitest';

/** Bucket boundaries the SDK applies when an instrument gives no advisory. */
export const SDK_DEFAULT_BOUNDARIES = [
  0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
];

/** A reader that only produces metrics when a test asks it to collect. */
class InMemoryMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

let reader: InMemoryMetricReader;

/**
 * Installs a fresh in-memory meter provider as the global one and returns it,
 * so a test can shut it down again. Later calls replace the provider, which is
 * how the lazy instrument binding is exercised.
 */
export function installMeterProvider(): MeterProvider {
  reader = new InMemoryMetricReader();
  const installed = new MeterProvider({readers: [reader]});
  metrics.disable();
  metrics.setGlobalMeterProvider(installed);
  return installed;
}

/** Collects every histogram recorded since the last collection, by name. */
export async function collectHistograms(): Promise<
  Map<string, HistogramMetricData>
> {
  const {resourceMetrics} = await reader.collect();
  const byName = new Map<string, HistogramMetricData>();
  for (const scopeMetric of resourceMetrics.scopeMetrics) {
    for (const metric of scopeMetric.metrics) {
      if (metric.dataPointType === DataPointType.HISTOGRAM) {
        byName.set(metric.descriptor.name, metric);
      }
    }
  }
  return byName;
}

/** Collects one named histogram, failing the test when it recorded nothing. */
export async function collectHistogram(
  name: string,
): Promise<HistogramMetricData> {
  const metric = (await collectHistograms()).get(name);
  if (!metric) {
    expect.fail(`no measurement recorded for ${name}`);
  }
  return metric;
}

/** Collects the single data point of a named histogram. */
export async function collectDataPoint(
  name: string,
): Promise<DataPoint<Histogram>> {
  const metric = await collectHistogram(name);
  expect(metric.dataPoints).toHaveLength(1);
  return metric.dataPoints[0];
}
