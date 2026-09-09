/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers that build the HTTP headers identifying an outbound call as ADK
 * traffic, and that fold those headers into a caller's own header map without
 * discarding either side's attribution.
 */

import {getClientLabels} from './client_labels.js';

const API_CLIENT_HEADER = 'x-goog-api-client';
const USER_AGENT_HEADER = 'user-agent';

const TOKEN_SEPARATOR = ' ';

/**
 * Returns the HTTP headers that identify a request as ADK traffic.
 *
 * The value is resolved on every call, so a label installed by
 * `runWithClientLabel` is picked up for the duration of that async context.
 */
export function getTrackingHeaders(): Record<string, string> {
  const headerValue = getClientLabels().join(TOKEN_SEPARATOR);
  return {
    [API_CLIENT_HEADER]: headerValue,
    [USER_AGENT_HEADER]: headerValue,
  };
}

/**
 * Merges the ADK tracking headers into a caller's header map.
 *
 * Both tracking headers hold a space-separated token list, so a caller's value
 * is appended to ADK's rather than replacing it. Tracking tokens come first,
 * caller tokens follow in their original order, and a token already present is
 * not repeated. Every other key is copied through untouched.
 *
 * @param headers The caller's headers. Not mutated.
 * @returns A new header map carrying both attributions.
 */
export function mergeTrackingHeaders(
  headers?: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {...headers};
  for (const [key, trackingValue] of Object.entries(getTrackingHeaders())) {
    const callerValue = merged[key];
    if (!callerValue) {
      merged[key] = trackingValue;
      continue;
    }
    const tokens = trackingValue.split(TOKEN_SEPARATOR);
    for (const token of callerValue.split(TOKEN_SEPARATOR)) {
      if (!tokens.includes(token)) {
        tokens.push(token);
      }
    }
    merged[key] = tokens.join(TOKEN_SEPARATOR);
  }
  return merged;
}
