/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StorageOptions} from '@google-cloud/storage';

import {experimental} from '../../utils/experimental.js';

/** Scopes requested when none are configured explicitly. */
export const GCS_DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/devstorage.full_control',
];

/** Options for {@link GcsCredentialsConfig}. */
export interface GcsCredentialsConfigOptions {
  /**
   * Ready-made options for the Cloud Storage client, and the place to pass an
   * already-authenticated client as `{authClient}`. That client is used for
   * every end user, so only set it when it is allowed to reach every end
   * user's data. Mutually exclusive with `clientId`, `clientSecret` and
   * `scopes`.
   */
  storageOptions?: StorageOptions;
  /** The OAuth client id to use. Requires `clientSecret`. */
  clientId?: string;
  /** The OAuth client secret to use. Requires `clientId`. */
  clientSecret?: string;
  /** The scopes to request. Defaults to {@link GCS_DEFAULT_SCOPES}. */
  scopes?: string[];
  /** The Google Cloud project the client operates against. */
  projectId?: string;
}

/**
 * Credentials configuration for the GCS toolsets (Experimental).
 *
 * Known limitation: an OAuth client id and secret alone carry no access
 * token. adk-python mints one by driving the interactive OAuth consent flow,
 * which adk-js does not implement yet, so requests made through the
 * `clientId`/`clientSecret` path fail at request time and surface as a normal
 * `{status: 'ERROR'}` tool result. Pass an authenticated client through
 * `storageOptions`, or pass no credentials config at all and rely on
 * Application Default Credentials.
 */
@experimental
export class GcsCredentialsConfig {
  readonly storageOptions?: StorageOptions;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly scopes: string[];
  readonly projectId?: string;

  constructor(options: GcsCredentialsConfigOptions) {
    if (
      options.storageOptions &&
      (options.clientId || options.clientSecret || options.scopes)
    ) {
      throw new Error(
        'If storageOptions are provided, clientId, clientSecret and scopes must not be provided.',
      );
    }
    if (
      !options.storageOptions &&
      !(options.clientId && options.clientSecret)
    ) {
      throw new Error(
        'Must provide either storageOptions, or both clientId and clientSecret.',
      );
    }

    this.storageOptions = options.storageOptions;
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
      ...(this.storageOptions ?? {
        clientOptions: {
          clientId: this.clientId,
          clientSecret: this.clientSecret,
        },
        scopes: this.scopes,
      }),
      ...(projectId ? {projectId} : {}),
    };
  }
}
