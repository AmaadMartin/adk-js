/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ServiceAccountCredential} from '../auth/auth_credential.js';
import {camelCaseKeys} from './case_utils.js';

/**
 * Whether `value` carries the two fields a key file needs to mint a token.
 *
 * The remaining fields of a key file are descriptive, so a file that omits one
 * still authenticates and is accepted here.
 */
function isServiceAccountCredential(
  value: unknown,
): value is ServiceAccountCredential {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const fields = value as Record<string, unknown>;
  return (
    typeof fields['clientEmail'] === 'string' &&
    fields['clientEmail'] !== '' &&
    typeof fields['privateKey'] === 'string' &&
    fields['privateKey'] !== ''
  );
}

/**
 * Parses a Google service account key file into a `ServiceAccountCredential`.
 *
 * A key file downloaded from Google Cloud uses snake_case keys, so the keys are
 * converted to the camelCase names the ADK credential types declare.
 *
 * @param json The contents of a service account key file.
 * @throws {Error} If the text is not JSON, or omits `client_email` or
 *     `private_key`.
 */
export function parseServiceAccountJson(
  json: string,
): ServiceAccountCredential {
  let parsed: unknown;
  try {
    parsed = camelCaseKeys(JSON.parse(json));
  } catch (error) {
    throw new Error(
      `Service account JSON is not valid JSON: ${(error as Error).message}`,
    );
  }

  if (!isServiceAccountCredential(parsed)) {
    throw new Error(
      "Service account JSON must be an object with 'client_email' and " +
        "'private_key'.",
    );
  }

  return parsed;
}
