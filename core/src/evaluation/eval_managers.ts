/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds the pair of eval managers a storage URI asks for.
 *
 * A port of adk-python's `src/google/adk/cli/utils/evals.py`. It lives in this
 * package rather than in the CLI because the API server needs the same pair.
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {EvalSetResultsManager} from './eval_set_results_manager.js';
import {EvalSetsManager} from './eval_sets_manager.js';
import {GcsEvalSetResultsManager} from './gcs_eval_set_results_manager.js';
import {GcsEvalSetsManager} from './gcs_eval_sets_manager.js';

/** The scheme of the only storage URI the eval managers support. */
const GCS_URI_SCHEME = 'gs://';

/** The eval sets and the eval results of one storage backend. */
export interface EvalManagers {
  evalSetsManager: EvalSetsManager;
  evalSetResultsManager: EvalSetResultsManager;
}

/**
 * Builds the GCS-backed eval managers for a `gs://<bucket>` URI. A path after
 * the bucket is ignored, because the managers own their blob layout.
 *
 * @throws {InputValidationError} When the URI names another scheme.
 */
export function createGcsEvalManagersFromUri(
  evalStorageUri: string,
): EvalManagers {
  if (!evalStorageUri.startsWith(GCS_URI_SCHEME)) {
    throw new InputValidationError(
      `Unsupported evals storage URI: ${evalStorageUri}. Supported URIs: ` +
        `gs://<bucket name>`,
    );
  }
  const bucketName = evalStorageUri.slice(GCS_URI_SCHEME.length).split('/')[0];
  return {
    evalSetsManager: new GcsEvalSetsManager(bucketName),
    evalSetResultsManager: new GcsEvalSetResultsManager(bucketName),
  };
}
