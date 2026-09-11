/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a developer sees when `@google-cloud/spanner` is not installed.
 *
 * Mocking `@google-cloud/spanner` itself cannot produce this: Vitest replaces
 * a failing module factory with its own error, which carries no
 * `ERR_MODULE_NOT_FOUND` code. So the real `loadOptionalPeer` runs here, over
 * a loader that fails the way Node fails. This file installs a module mock, so
 * it stays separate from the other Spanner tests.
 */

import {SpannerAdminToolset} from '@google/adk/tools/spanner';
import {describe, expect, it, vi} from 'vitest';
import {
  withDatabaseAdminClient,
  withInstanceAdminClient,
} from '../../../src/tools/spanner/client.js';
import {logger} from '../../../src/utils/logger.js';
import {
  errorOf,
  runTool,
  testAuthClient,
  testCredentialsConfig,
} from './spanner_test_utils.js';

vi.mock('../../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/utils/optional_peer.js')
    >();
  const loadOptionalPeer: typeof actual.loadOptionalPeer = (peer) =>
    actual.loadOptionalPeer(peer, () => {
      const error = new Error(`Cannot find package '${peer.packageName}'`);
      Object.assign(error, {code: 'ERR_MODULE_NOT_FOUND'});
      return Promise.reject(error);
    });
  return {...actual, loadOptionalPeer};
});

const ADMIN_TARGET = {projectId: 'p', authClient: testAuthClient()};

describe('the Spanner client module without its peer dependency', () => {
  it('names @google-cloud/spanner and the install command', async () => {
    const promise = withInstanceAdminClient(
      ADMIN_TARGET,
      async () => undefined,
    );

    await expect(promise).rejects.toThrow(/SpannerAdminToolset requires/);
    await expect(promise).rejects.toThrow(/npm install @google-cloud\/spanner/);
  });

  it('names the install command for the database admin endpoint too', async () => {
    const promise = withDatabaseAdminClient(
      ADMIN_TARGET,
      async () => undefined,
    );

    await expect(promise).rejects.toThrow(/npm install @google-cloud\/spanner/);
  });

  it('reports the missing peer to the model as an error result', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const toolset = new SpannerAdminToolset({
      credentialsConfig: testCredentialsConfig(),
    });

    const result = await runTool(toolset, 'spanner_list_instances', {
      project_id: 'p',
    });

    expect(errorOf(result)).toContain('npm install @google-cloud/spanner');
  });
});
