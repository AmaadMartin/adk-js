/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {GCS_TOOL_USER_AGENT, createGcsClient} from './client.js';
export {GCS_DEFAULT_SCOPE} from './gcs_credentials.js';
export type {GcsCredentialsConfig} from './gcs_credentials.js';
export {DEFAULT_GCS_CAPABILITIES, GcsCapability} from './settings.js';
export type {GcsToolSettings} from './settings.js';
export {
  createGcsReadTools,
  createGcsWriteTools,
  createObject,
  deleteObjects,
  getObjectData,
  getObjectMetadata,
  listObjects,
} from './storage_tool.js';
export type {
  CreateObjectArgs,
  DeleteObjectsArgs,
  GcsClientProvider,
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
