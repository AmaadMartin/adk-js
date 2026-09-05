/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AsyncLocalStorage} from 'node:async_hooks';
import {version} from '../version.js';
import {isBrowser} from './env_aware_utils.js';

const ADK_LABEL = 'google-adk';
const LANGUAGE_LABEL = 'gl-typescript';
const AGENT_ENGINE_TELEMETRY_TAG = 'remote_reasoning_engine';
const AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME = 'GOOGLE_CLOUD_AGENT_ENGINE_ID';

const clientLabelLocalStorage = new AsyncLocalStorage<string>();

const USER_AGENT_PATTERNS = [
  ['Edge', /(?:Edg|Edge|EdgA)\/([0-9.]+)/i],
  ['Firefox', /(?:Firefox|FxiOS)\/([0-9.]+)/i],
  ['Chrome', /(?:Chrome|CriOS)\/([0-9.]+)/i],
  ['Safari', /Version\/([0-9.]+).*Safari/i],
] as const;

export function parseUserAgent(userAgent: string): string {
  if (!userAgent) {
    return 'Browser';
  }

  for (const [name, regex] of USER_AGENT_PATTERNS) {
    const match = userAgent.match(regex);
    if (match) {
      return `${name}/${match[1]}`;
    }
  }

  return 'Browser';
}

function _getDefaultLabels(frameworkLabel?: string): string[] {
  let frameworkToken = `${ADK_LABEL}/${version}`;

  if (!isBrowser() && process.env[AGENT_ENGINE_TELEMETRY_ENV_VARIABLE_NAME]) {
    frameworkToken = `${frameworkToken}+${AGENT_ENGINE_TELEMETRY_TAG}`;
  }

  if (frameworkLabel) {
    frameworkToken = `${frameworkToken}+${frameworkLabel}`;
  }

  const languageLabelDetail = isBrowser()
    ? // eslint-disable-next-line no-undef
      parseUserAgent(window.navigator.userAgent)
    : process.version;

  const languageLabel = `${LANGUAGE_LABEL}/${languageLabelDetail}`;
  return [frameworkToken, languageLabel];
}

/**
 * Runs the given callback within a context that has the specified client label.
 * All LLM calls made within this callback will include the client label in their tracking headers.
 *
 * @param clientLabel The custom client label to apply.
 * @param callback The callback function to execute.
 * @return The result of the callback.
 */
export function runWithClientLabel<R>(
  clientLabel: string,
  callback: () => R,
): R {
  if (typeof clientLabel !== 'string' || clientLabel.trim() === '') {
    throw new Error('Client label must be a non-empty string.');
  }

  return clientLabelLocalStorage.run(clientLabel, callback);
}

/**
 * Returns the current list of client labels that can be added to HTTP Headers.
 *
 * @param frameworkLabel Optional SemVer build-metadata suffix appended to the
 *     `google-adk/<version>` token (e.g. `managed_agent`), which tells Google's
 *     server-side usage pipeline which ADK surface issued the call.
 */
export function getClientLabels(frameworkLabel?: string): string[] {
  const labels = _getDefaultLabels(frameworkLabel);
  const contextLabel = clientLabelLocalStorage.getStore();
  if (contextLabel) {
    labels.push(contextLabel);
  }
  return labels;
}

/**
 * Returns the HTTP headers that attribute an outbound call to ADK.
 *
 * @param frameworkLabel Optional ADK surface suffix, as on
 *     {@link getClientLabels}.
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
 * Merges the ADK tracking headers into `headers` without discarding a
 * caller-supplied value.
 *
 * A header the caller did not set takes the tracking value. A header the caller
 * did set keeps its own space-separated tokens and gains the tracking tokens it
 * is missing, so a custom `user-agent` stays attributable to ADK. Neither
 * `headers` nor its values are mutated.
 *
 * @param headers The caller's headers, or undefined when there are none.
 * @param frameworkLabel Optional ADK surface suffix, as on
 *     {@link getClientLabels}.
 * @return A new headers map carrying both sets of tokens.
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
    const parts = trackingValue.split(' ');
    for (const customPart of customValue.split(' ')) {
      if (!parts.includes(customPart)) {
        parts.push(customPart);
      }
    }
    merged[key] = parts.join(' ');
  }
  return merged;
}
