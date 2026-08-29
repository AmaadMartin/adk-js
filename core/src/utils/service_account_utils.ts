/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ServiceAccountCredential} from '../auth/auth_credential.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {camelCaseKeys} from './case_utils.js';
import {asJsonObject, readString} from './json_utils.js';

/** Value the `type` field of a service account key file carries. */
const SERVICE_ACCOUNT_TYPE = 'service_account';

/**
 * Parses the contents of a Google Cloud service account key file.
 *
 * A key file names its fields in snake_case, so they are converted to the
 * camelCase {@link ServiceAccountCredential} shape. Only the credential
 * exchange reads `privateKey` and `clientEmail`, so those two are checked. The
 * rest fill the non-optional members of the shape and default to empty, which
 * keeps a key file that predates a field readable.
 *
 * @throws {InputValidationError} If the text is not a JSON object, names
 *     another type, or leaves the private key or the client email empty.
 */
export function parseServiceAccountCredential(
  serviceAccountJson: string,
): ServiceAccountCredential {
  const key = readKeyFile(serviceAccountJson);
  const type = requiredString(key, 'type');
  if (type !== SERVICE_ACCOUNT_TYPE) {
    throw new InputValidationError(
      `Service account key must name the type "${SERVICE_ACCOUNT_TYPE}".`,
    );
  }
  return {
    type: SERVICE_ACCOUNT_TYPE,
    projectId: readString(key, 'projectId'),
    privateKeyId: readString(key, 'privateKeyId'),
    privateKey: requiredString(key, 'privateKey'),
    clientEmail: requiredString(key, 'clientEmail'),
    clientId: readString(key, 'clientId'),
    authUri: readString(key, 'authUri'),
    tokenUri: readString(key, 'tokenUri'),
    authProviderX509CertUrl: readString(key, 'authProviderX509CertUrl'),
    clientX509CertUrl: readString(key, 'clientX509CertUrl'),
    universeDomain: readString(key, 'universeDomain'),
  };
}

/** Decodes a key file into its camelCase fields. */
function readKeyFile(serviceAccountJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serviceAccountJson);
  } catch {
    // A `JSON.parse` message quotes a window of its input, which for a key
    // file is private key bytes, so the original message is dropped.
    throw new InputValidationError('Service account key is not valid JSON.');
  }
  const key = asJsonObject(camelCaseKeys(parsed));
  if (!key) {
    throw new InputValidationError(
      'Service account key must be a JSON object.',
    );
  }
  return key;
}

/**
 * Reads one required field. The value is never quoted back, so a malformed key
 * cannot copy its private key into an error message.
 */
function requiredString(key: Record<string, unknown>, field: string): string {
  const value = key[field];
  if (typeof value !== 'string' || value === '') {
    throw new InputValidationError(
      `Service account key is missing the required field "${field}".`,
    );
  }
  return value;
}
