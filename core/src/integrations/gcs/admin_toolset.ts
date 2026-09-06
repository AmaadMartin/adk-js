/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../utils/experimental.js';
import {createAdminReadTools, createAdminWriteTools} from './admin_tool.js';
import {GcsToolsetBase, GcsToolsetOptions} from './toolset_base.js';

/** Options for {@link GcsAdminToolset}. */
export type GcsAdminToolsetOptions = GcsToolsetOptions;

/**
 * Toolset for Cloud Storage bucket administration (Experimental).
 *
 * The tool names are `gcs_list_buckets` and, with the
 * `GcsCapability.READ_WRITE` capability, `gcs_create_bucket`,
 * `gcs_update_bucket` and `gcs_delete_bucket`.
 *
 * This toolset is deliberately separate from `GcsToolset`: granting it hands
 * an agent bucket-level privileges, including bucket deletion.
 */
@experimental
export class GcsAdminToolset extends GcsToolsetBase {
  constructor(options: GcsAdminToolsetOptions = {}) {
    super(options, {read: createAdminReadTools, write: createAdminWriteTools});
  }
}
