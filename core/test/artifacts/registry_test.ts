/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseArtifactService,
  FileArtifactService,
  GcsArtifactService,
  InMemoryArtifactService,
  getArtifactServiceFromUri,
  getServiceRegistry,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

describe('getArtifactServiceFromUri', () => {
  it('returns InMemoryArtifactService for memory uri', () => {
    const service = getArtifactServiceFromUri('memory://');
    expect(service).toBeInstanceOf(InMemoryArtifactService);
  });

  it('returns GcsArtifactService for gs uri', () => {
    const service = getArtifactServiceFromUri('gs://my-bucket');
    expect(service).toBeInstanceOf(GcsArtifactService);
    expect((service as unknown as {bucket: {name: string}}).bucket.name).toBe(
      'my-bucket',
    );
  });

  it('returns FileArtifactService for file uri', () => {
    const service = getArtifactServiceFromUri('file:///tmp/artifacts');
    expect(service).toBeInstanceOf(FileArtifactService);
  });

  it('throws error for unsupported uri', () => {
    expect(() => getArtifactServiceFromUri('unsupported://uri')).toThrow(
      'Unsupported artifact service URI: unsupported://uri',
    );
  });
});

describe('getArtifactServiceFromUri with a registered scheme', () => {
  // The process-wide registry has no unregister API, so this scheme is unique
  // to this file.
  const CUSTOM_SCHEME = 'customartifacttest';

  it('serves the scheme and hands the factory the uri and options', () => {
    const service = {} as BaseArtifactService;
    const factory = vi.fn().mockReturnValue(service);
    getServiceRegistry().registerArtifactService(CUSTOM_SCHEME, factory);

    const resolved = getArtifactServiceFromUri(`${CUSTOM_SCHEME}://store/x`, {
      agentsDir: '/agents',
    });

    expect(resolved).toBe(service);
    expect(factory).toHaveBeenCalledExactlyOnceWith(
      `${CUSTOM_SCHEME}://store/x`,
      {agentsDir: '/agents'},
    );
  });

  it('redacts a password in the unsupported uri message', () => {
    expect(() =>
      getArtifactServiceFromUri('unsupported://user:hunter2@host/bucket'),
    ).toThrow(
      'Unsupported artifact service URI: unsupported://user:***@host/bucket',
    );
  });
});
