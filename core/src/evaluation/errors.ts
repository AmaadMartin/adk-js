/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thrown when an eval run finishes with at least one metric below its
 * threshold. The message carries the full failure report.
 */
export class EvalFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalFailureError';
  }
}

/**
 * Thrown when an eval config selects a metric that adk-js cannot score.
 *
 * The registry resolves an evaluator for every prebuilt metric name, but some
 * of those evaluators call the Vertex Gen AI Eval service, which adk-js does
 * not ship. Refusing the metric by name says so plainly, rather than failing
 * later inside the evaluator.
 */
export class UnsupportedMetricError extends Error {
  constructor(metricName: string) {
    super(
      `Metric ${metricName} needs the Vertex Gen AI Eval service, which` +
        ' adk-js does not ship. Remove it from the eval config criteria.',
    );
    this.name = 'UnsupportedMetricError';
  }
}
