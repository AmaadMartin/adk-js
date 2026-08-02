/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StorageOptions} from '@google-cloud/storage';

import {experimental} from '../../utils/experimental.js';

/**
 * An already-authenticated client accepted by the Cloud Storage client.
 *
 * Derived from `StorageOptions` so it always matches the auth library version
 * `@google-cloud/storage` itself resolves.
 */
export type GcsAuthClient = NonNullable<StorageOptions['authClient']>;

/** Scopes requested when none are configured explicitly. */
export const GCS_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/devstorage.full_control',
];

/** Options for {@link GCSCredentialsConfig}. */
export interface GCSCredentialsConfigOptions {
  /**
   * An existing auth client to use for every end user. Mutually exclusive
   * with `clientId`, `clientSecret` and `scopes`.
   */
  credentials?: GcsAuthClient;
  /** The OAuth client id to use. Requires `clientSecret`. */
  clientId?: string;
  /** The OAuth client secret to use. Requires `clientId`. */
  clientSecret?: string;
  /** The scopes to request. Defaults to {@link GCS_DEFAULT_SCOPES}. */
  scopes?: string[];
  /** The Google Cloud project the client bills and operates against. */
  projectId?: string;
}

/**
 * Credentials configuration for the GCS toolsets (Experimental).
 *
 * Known limitation: an OAuth client id and secret alone carry no access
 * token. adk-python mints one by driving the interactive OAuth consent flow,
 * which adk-js does not implement yet, so requests made through the
 * `clientId`/`clientSecret` path fail at request time and surface as a normal
 * `{status: 'ERROR'}` tool result. Pass a pre-built `credentials` client, or
 * pass no credentials config at all and rely on Application Default
 * Credentials.
 */
@experimental
export class GCSCredentialsConfig {
  readonly credentials?: GcsAuthClient;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scopes: string[];
  readonly projectId?: string;

  constructor(options: GCSCredentialsConfigOptions) {
    if (
      options.credentials &&
      (options.clientId || options.clientSecret || options.scopes)
    ) {
      throw new Error(
        'If credentials are provided, clientId, clientSecret and scopes must not be provided.',
      );
    }
    if (!options.credentials && !(options.clientId && options.clientSecret)) {
      throw new Error(
        'Must provide either credentials, or both clientId and clientSecret.',
      );
    }

    this.credentials = options.credentials;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scopes = options.scopes ?? GCS_DEFAULT_SCOPES;
    this.projectId = options.projectId;
  }

  /**
   * Builds the options used to construct a Cloud Storage client.
   *
   * @param project Overrides the configured `projectId` when supplied.
   */
  toStorageOptions(project?: string): StorageOptions {
    const projectId = project ?? this.projectId;
    return {
      ...(projectId ? {projectId} : {}),
      ...(this.credentials
        ? {authClient: this.credentials}
        : {
            clientOptions: {
              clientId: this.clientId,
              clientSecret: this.clientSecret,
            },
            scopes: this.scopes,
          }),
    };
  }
}
