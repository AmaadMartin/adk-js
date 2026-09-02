/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';

/** How `adk conformance test` verifies a test case. */
export enum ConformanceMode {
  /** Compare the run against the recorded interactions. */
  REPLAY = 'replay',
  /** Evaluation-based verification. Not implemented. */
  LIVE = 'live',
}

/** Outcome of one conformance test case. */
export enum ConformanceStatus {
  PASSED = 'passed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

/** Result of one conformance test case. */
export interface ConformanceTestResult {
  category: string;
  name: string;
  description: string;
  status: ConformanceStatus;
  /** Populated only for FAILED. */
  error?: string;
}

/** Results of one conformance run. */
export interface ConformanceTestSummary {
  /** The fixture set the user selected, or undefined when they did not. */
  streamingMode?: StreamingMode;
  results: ConformanceTestResult[];
}

/** The streaming mode values the conformance commands accept. */
export const STREAMING_MODE_VALUES: readonly string[] =
  Object.values(StreamingMode);

/** The `--mode` values `adk conformance test` accepts. */
export const CONFORMANCE_MODE_VALUES: readonly string[] =
  Object.values(ConformanceMode);

/**
 * Matches a command-line value against the streaming modes, ignoring case.
 *
 * adk-python spells its non-streaming value `None`, so a case-insensitive
 * match accepts both spellings of the same mode.
 */
export function parseStreamingMode(value: string): StreamingMode | undefined {
  return Object.values(StreamingMode).find(
    (mode) => mode.toLowerCase() === value.toLowerCase(),
  );
}

/** Matches a command-line value against the test modes, ignoring case. */
export function parseConformanceMode(
  value: string,
): ConformanceMode | undefined {
  return Object.values(ConformanceMode).find(
    (mode) => mode === value.toLowerCase(),
  );
}
