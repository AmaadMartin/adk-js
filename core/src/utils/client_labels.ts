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

/**
 * Marks the LLM calls an eval run makes, so that the charges an eval incurs
 * can be told apart from the charges of serving traffic.
 */
export const EVAL_CLIENT_LABEL = `google-adk-eval/${version}`;

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
 * Returns the headers that identify this client to Google APIs, built from
 * {@link getClientLabels}.
 *
 * Mirrors adk-python `utils/_google_client_headers.py`, so server-side usage
 * data can separate ADK calls from any other caller of the same API.
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
 * Returns a copy of `headers` with the tracking headers merged in.
 *
 * A caller's own value for a tracking header is kept: its labels are appended
 * after the ADK ones, and a label the caller already carries is not repeated.
 * The argument is never modified.
 *
 * @param headers The caller's headers, or undefined when there are none.
 * @param frameworkLabel Optional ADK surface suffix, as on
 *     {@link getClientLabels}.
 * @return A new headers map carrying both sets of tokens.
 */
export function mergeTrackingHeaders(
  headers?: Record<string, string>,
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
