/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {GCS_TOOL_USER_AGENT, createGcsClient} from './client.js';
export {GCS_DEFAULT_SCOPE} from './gcs_credentials.js';
export type {GcsCredentialsConfig} from './gcs_credentials.js';
export {GcsCapability} from './settings.js';
// The parameter schemas are published because the exported `*Args` types are
// inferred from them, and typedoc resolves an inferred type only when the
// schema it names is itself documented.
export {
  createObject,
  createObjectParameters,
  deleteObjects,
  deleteObjectsParameters,
  getObjectData,
  getObjectDataParameters,
  getObjectMetadata,
  getObjectMetadataParameters,
  listObjects,
  listObjectsParameters,
} from './storage_tool.js';
export type {
  CreateObjectArgs,
  DeleteObjectsArgs,
  GcsErrorResult,
  GcsListObjectsResult,
  GcsMessageResult,
  GcsObjectDataResult,
  GcsObjectMetadataResult,
  GetObjectDataArgs,
  GetObjectMetadataArgs,
  ListObjectsArgs,
} from './storage_tool.js';
export {DEFAULT_GCS_TOOL_NAME_PREFIX, GcsToolset} from './storage_toolset.js';
export type {GcsToolsetOptions} from './storage_toolset.js';
