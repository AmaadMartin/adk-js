/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** How the Eventarc tools authenticate, and the check that the config is sane. */

import {InputValidationError} from '../../errors/input_validation_error.js';
import type {AuthorizedUserCredentials, EventarcSdkCredentials} from './sdk.js';

/** The fields a service-account key must carry. */
const SERVICE_ACCOUNT_FIELDS = ['client_email', 'private_key'];

/** The fields an authorized-user credential must carry. */
const AUTHORIZED_USER_FIELDS = ['client_id', 'client_secret', 'refresh_token'];

/**
 * How the Eventarc tools authenticate.
 *
 * Name at most one credential source. With none, the client uses Application
 * Default Credentials.
 */
export interface EventarcCredentialsConfig {
  /** An inline credential body, as Google's client libraries read it. */
  credentials?: EventarcSdkCredentials;
  /** A path to a service-account key file, read by the SDK. */
  keyFilename?: string;
  /** OAuth scopes. Omit for the SDK's default. */
  scopes?: string[];
}

/** Whether a credential body declares itself an authorized user. */
function isAuthorizedUser(
  credentials: EventarcSdkCredentials,
): credentials is AuthorizedUserCredentials {
  return 'type' in credentials && credentials.type === 'authorized_user';
}

/** The fields a credential body's kind requires but it does not carry. */
function missingFields(credentials: EventarcSdkCredentials): string[] {
  const required = isAuthorizedUser(credentials)
    ? AUTHORIZED_USER_FIELDS
    : SERVICE_ACCOUNT_FIELDS;
  const present: Record<string, unknown> = {...credentials};
  return required.filter((field) => {
    const value = present[field];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/**
 * Rejects a credentials config that names more than one source, or that
 * carries an incomplete credential body.
 *
 * Google's auth library silently prefers `credentials` over `keyFilename`, so
 * a config naming both publishes under an identity the developer may not have
 * chosen. This raises instead of picking one.
 *
 * @param config The config to check.
 * @throws {InputValidationError} If the config names two sources, or the
 *   credential body is missing a field its kind requires.
 */
export function validateEventarcCredentialsConfig(
  config: EventarcCredentialsConfig,
): void {
  if (config.credentials !== undefined && config.keyFilename !== undefined) {
    throw new InputValidationError(
      'EventarcCredentialsConfig names two credential sources, credentials ' +
        'and keyFilename. Name one, or neither for Application Default ' +
        'Credentials.',
    );
  }
  if (config.credentials === undefined) {
    return;
  }
  const missing = missingFields(config.credentials);
  if (missing.length > 0) {
    const kind = isAuthorizedUser(config.credentials)
      ? 'an authorized_user credential'
      : 'a service account key';
    throw new InputValidationError(
      `EventarcCredentialsConfig.credentials is ${kind} missing ` +
        `${missing.join(', ')}.`,
    );
  }
}
