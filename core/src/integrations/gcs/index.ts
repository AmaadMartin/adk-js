/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cloud Storage tools (Experimental).
 *
 * These tools are hand crafted, unlike the generated tools under
 * `tools/google_api_tool`, so that an agent gets one integrated way to
 * administer Cloud Storage buckets, with the developer in control of the
 * credentials and of whether the agent may write at all.
 */

export {
  createBucket,
  deleteBucket,
  getBucket,
  listBuckets,
  updateBucket,
  type BucketOptions,
  type CreateBucketOptions,
  type GcsAdminToolResult,
  type ListBucketsOptions,
  type UpdateBucketOptions,
} from './admin_tool.js';
export {
  DEFAULT_GCS_TOOL_NAME_PREFIX,
  GcsAdminToolset,
  type GcsAdminToolsetOptions,
} from './admin_toolset.js';
export {
  GCS_PEER,
  GCS_USER_AGENT,
  asStorageAuthClient,
  getGcsClient,
  type GcsClientOptions,
} from './client.js';
export {
  GCS_DEFAULT_SCOPE,
  GCS_TOKEN_CACHE_KEY,
  GcsCredentialsConfig,
  type GcsCredentialsConfigOptions,
} from './gcs_credentials.js';
export {
  DEFAULT_GCS_TOOL_SETTINGS,
  GcsCapability,
  type GcsToolSettings,
} from './settings.js';
