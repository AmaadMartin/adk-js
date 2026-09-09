/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getServiceRegistry} from '@google/adk-devtools';

import {FakeSessionService} from './fake_session_service.js';

getServiceRegistry().registerSessionService(
  'fake',
  (uri) => new FakeSessionService(uri),
);
