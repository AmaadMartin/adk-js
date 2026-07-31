/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  loadOptionalDependency,
  OptionalDependency,
} from '../../src/utils/optional_dependency_utils.js';

const STORAGE: OptionalDependency = {
  packageName: '@google-cloud/storage',
  feature: 'GcsArtifactService',
};

/** Builds a rejection that looks like a Node module-resolution failure. */
function moduleError(code: string, message: string): Error {
  return Object.assign(new Error(message), {code});
}

describe('loadOptionalDependency', () => {
  it('returns the loaded module namespace unchanged', async () => {
    const namespace = {Storage: class {}};

    await expect(
      loadOptionalDependency(() => Promise.resolve(namespace), STORAGE),
    ).resolves.toBe(namespace);
  });

  it('translates an ESM resolution failure into install instructions', async () => {
    const error = moduleError(
      'ERR_MODULE_NOT_FOUND',
      "Cannot find package '@google-cloud/storage' imported from /app/index.js",
    );

    await expect(
      loadOptionalDependency(() => Promise.reject(error), STORAGE),
    ).rejects.toThrow(
      'GcsArtifactService requires the optional peer dependency ' +
        "'@google-cloud/storage', which is not installed. " +
        'Run `npm install @google-cloud/storage` to enable it.',
    );
  });

  it('translates a CJS resolution failure into the same install instructions', async () => {
    const error = moduleError(
      'MODULE_NOT_FOUND',
      "Cannot find module '@google-cloud/storage'",
    );

    await expect(
      loadOptionalDependency(() => Promise.reject(error), STORAGE),
    ).rejects.toThrow('Run `npm install @google-cloud/storage` to enable it.');
  });

  it('rethrows a missing transitive dependency of the package unchanged', async () => {
    const error = moduleError(
      'ERR_MODULE_NOT_FOUND',
      "Cannot find package 'teeny-request' imported from " +
        '/app/node_modules/@google-cloud/storage/build/src/util.js',
    );

    await expect(
      loadOptionalDependency(() => Promise.reject(error), STORAGE),
    ).rejects.toBe(error);
  });

  it('rethrows an error the package throws while evaluating', async () => {
    const error = new TypeError('boom');

    await expect(
      loadOptionalDependency(() => Promise.reject(error), STORAGE),
    ).rejects.toBe(error);
  });

  it('rethrows an error whose code is not a resolution failure', async () => {
    const error = moduleError(
      'ENOENT',
      "Cannot find module '@google-cloud/storage'",
    );

    await expect(
      loadOptionalDependency(() => Promise.reject(error), STORAGE),
    ).rejects.toBe(error);
  });

  it('rethrows a non-Error rejection unchanged', async () => {
    await expect(
      loadOptionalDependency(() => Promise.reject('nope'), STORAGE),
    ).rejects.toBe('nope');
  });

  it('names the requesting feature, not just the package', async () => {
    const error = moduleError(
      'MODULE_NOT_FOUND',
      "Cannot find module '@google-cloud/opentelemetry-cloud-trace-exporter'",
    );

    await expect(
      loadOptionalDependency(() => Promise.reject(error), {
        packageName: '@google-cloud/opentelemetry-cloud-trace-exporter',
        feature: 'Cloud Trace export (enableTracing)',
      }),
    ).rejects.toThrow(
      'Cloud Trace export (enableTracing) requires the optional peer ' +
        "dependency '@google-cloud/opentelemetry-cloud-trace-exporter'",
    );
  });
});
