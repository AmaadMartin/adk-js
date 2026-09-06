/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HttpOptions} from '@google/genai';
import {getClientLabels} from './client_labels.js';

/**
 * Returns the HTTP headers that identify ADK as the caller.
 *
 * Both headers carry the same joined {@link getClientLabels} value, so a
 * backend reading either one sees the framework, its version and the runtime.
 *
 * @param frameworkLabel Optional SemVer build-metadata suffix appended to the
 *   `google-adk` token, e.g. `managed_agent`. It names the ADK surface that
 *   made the call.
 */
export function getTrackingHeaders(
  frameworkLabel?: string,
): Record<string, string> {
  const headerValue = getClientLabels(frameworkLabel).join(' ');
  return {
    'x-goog-api-client': headerValue,
    'user-agent': headerValue,
  };
}

/**
 * Returns {@link HttpOptions} carrying the ADK tracking headers.
 *
 * Pass it when you construct a genai client, so every call that client makes
 * is attributable to ADK.
 */
export function getTrackingHttpOptions(frameworkLabel?: string): HttpOptions {
  return {headers: getTrackingHeaders(frameworkLabel)};
}

/**
 * Merges the ADK tracking headers into caller-supplied headers.
 *
 * The caller keeps its own tokens: for a header the caller already set, this
 * appends the caller's tokens to the tracking value, and drops a token that
 * the tracking value already carries.
 */
export function mergeTrackingHeaders(
  headers: Record<string, string> | undefined,
  frameworkLabel?: string,
): Record<string, string> {
  const merged: Record<string, string> = {...headers};

  for (const [key, trackingValue] of Object.entries(
    getTrackingHeaders(frameworkLabel),
  )) {
    const customValue = merged[key];
    if (!customValue) {
      merged[key] = trackingValue;
      continue;
    }

    const valueParts = trackingValue.split(' ');
    for (const customPart of customValue.split(' ')) {
      if (!valueParts.includes(customPart)) {
        valueParts.push(customPart);
      }
    }
    merged[key] = valueParts.join(' ');
  }

  return merged;
}
