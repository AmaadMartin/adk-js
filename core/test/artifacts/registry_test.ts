/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FileArtifactService,
  GcsArtifactService,
  InMemoryArtifactService,
  getArtifactServiceFromUri,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

const {StorageMock, bucketMock} = vi.hoisted(() => {
  const bucketMock = vi.fn((name: string) => ({
    name,
    getFiles: async () => [[]],
  }));
  const StorageMock = vi.fn(() => ({bucket: bucketMock}));
  return {StorageMock, bucketMock};
});

vi.mock('@google-cloud/storage', () => ({Storage: StorageMock}));

describe('getArtifactServiceFromUri', () => {
  it('returns InMemoryArtifactService for memory uri', () => {
    const service = getArtifactServiceFromUri('memory://');
    expect(service).toBeInstanceOf(InMemoryArtifactService);
  });

  it('returns GcsArtifactService for gs uri', async () => {
    const service = getArtifactServiceFromUri('gs://my-bucket');
    expect(service).toBeInstanceOf(GcsArtifactService);

    await service.listArtifactKeys({
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'test-session',
    });

    expect(bucketMock).toHaveBeenCalledWith('my-bucket');
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
