/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';

import {
  EVENTARC_SDK_MISSING_ERROR,
  getPublisherClient,
  loadPublisherClientCtor,
} from '../../../src/integrations/eventarc/client.js';

/**
 * Reproduces an installation without the optional
 * `@google-cloud/eventarc-publishing` peer dependency.
 *
 * The failure lives in its own file because a module mock that fails to load
 * cannot be undone for later tests in the same module registry.
 */
vi.mock('@google-cloud/eventarc-publishing', () => {
  throw new Error("Cannot find package '@google-cloud/eventarc-publishing'");
});

describe('the optional Eventarc SDK is not installed', () => {
  it('reports a clear error from loadPublisherClientCtor', async () => {
    await expect(loadPublisherClientCtor()).rejects.toThrow(
      EVENTARC_SDK_MISSING_ERROR,
    );
  });

  it('reports the same error from getPublisherClient', async () => {
    await expect(getPublisherClient({projectId: 'my-project'})).rejects.toThrow(
      EVENTARC_SDK_MISSING_ERROR,
    );
  });
});
