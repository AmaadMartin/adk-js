/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../utils/experimental.js';
import {
  createStorageReadTools,
  createStorageWriteTools,
} from './storage_tool.js';
import {GcsToolsetBase, GcsToolsetOptions} from './toolset_base.js';

/**
 * Toolset for interacting with objects in Cloud Storage (Experimental).
 *
 * The tool names are `gcs_get_bucket`, `gcs_get_object_data`,
 * `gcs_get_object_metadata`, `gcs_list_objects` and, with the
 * `GcsCapability.READ_WRITE` capability, `gcs_create_object` and
 * `gcs_delete_objects`.
 *
 * Bucket administration lives in `GcsAdminToolset` so that an agent can be
 * granted object access without being granted the ability to delete a
 * bucket.
 */
@experimental
export class GcsToolset extends GcsToolsetBase {
  constructor(options: GcsToolsetOptions = {}) {
    super(options, {
      read: createStorageReadTools,
      write: createStorageWriteTools,
    });
  }
}
