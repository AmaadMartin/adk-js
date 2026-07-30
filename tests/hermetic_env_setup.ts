/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {scrubAmbientCloudEnv} from './hermetic_env.js';

// Runs in every unit-test worker before the test module is imported, so no
// unit test can read the developer machine's real gcloud / Vertex AI settings.
// A plain delete (rather than `vi.stubEnv`) survives `vi.unstubAllEnvs()`.
scrubAmbientCloudEnv();
