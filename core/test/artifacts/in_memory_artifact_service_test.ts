/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe} from 'vitest';
import {InMemoryArtifactService} from '../../src/index.js';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';

describe('InMemoryArtifactService', () => {
  runArtifactServiceTests(
    async () => new InMemoryArtifactService(),
    async () => {},
  );
});
