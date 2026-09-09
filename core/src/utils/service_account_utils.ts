/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {asJsonObject} from './json_utils.js';

/** The two fields a service account signs with. */
export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
}

/**
 * Reads the signing fields out of a Google Cloud service account key file.
 *
 * `google-auth-library` validates and uses the key, so only the two fields it
 * signs with are read here. Neither the parse nor the guards below quote the
 * file, because a key file is mostly private key bytes.
 *
 * @throws {InputValidationError} If the text is not a JSON object, or leaves
 *     the client email or the private key empty.
 */
export function parseServiceAccountKey(
  serviceAccountJson: string,
): ServiceAccountKey {
  const key = readKeyFile(serviceAccountJson);
  return {
    clientEmail: requiredString(key, 'client_email'),
    privateKey: requiredString(key, 'private_key'),
  };
}

function readKeyFile(serviceAccountJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serviceAccountJson);
  } catch {
    throw new InputValidationError('Service account key is not valid JSON.');
  }
  const key = asJsonObject(parsed);
  if (!key) {
    throw new InputValidationError(
      'Service account key must be a JSON object.',
    );
  }
  return key;
}

function requiredString(key: Record<string, unknown>, field: string): string {
  const value = key[field];
  if (typeof value !== 'string' || value === '') {
    throw new InputValidationError(
      `Service account key is missing the required field "${field}".`,
    );
  }
  return value;
}
