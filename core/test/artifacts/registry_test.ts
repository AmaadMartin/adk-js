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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const {StorageMock, bucketMock} = vi.hoisted(() => {
  const bucketMock = vi.fn((name: string) => ({name}));
  const StorageMock = vi.fn(() => ({bucket: bucketMock}));
  return {StorageMock, bucketMock};
});

vi.mock('@google-cloud/storage', () => ({Storage: StorageMock}));

/**
 * Forces `service` to resolve its bucket. `@google-cloud/storage` is an
 * optional peer loaded on first use, so nothing reaches `Storage` until an
 * operation needs the bucket handle.
 */
async function resolveBucket(service: unknown): Promise<void> {
  await (service as {getBucket(): Promise<unknown>}).getBucket();
}

describe('getArtifactServiceFromUri', () => {
  it('returns InMemoryArtifactService for memory uri', () => {
    const service = getArtifactServiceFromUri('memory://');
    expect(service).toBeInstanceOf(InMemoryArtifactService);
  });

  it('returns GcsArtifactService for gs uri', () => {
    const service = getArtifactServiceFromUri('gs://my-bucket');
    expect(service).toBeInstanceOf(GcsArtifactService);
    // The GCS client is an optional peer loaded on first use, so the bucket
    // handle does not exist until then; the parsed name is what the registry
    // is responsible for and it is all that can be asserted synchronously.
    expect((service as unknown as {bucketName: string}).bucketName).toBe(
      'my-bucket',
    );
  });

  describe('gs:// URIs', () => {
    let warnSpy: MockInstance<typeof logger.warn>;

    beforeEach(() => {
      bucketMock.mockClear();
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('passes the bucket name through for a gs uri without a path', async () => {
      await resolveBucket(getArtifactServiceFromUri('gs://my-bucket'));
      expect(bucketMock).toHaveBeenCalledWith('my-bucket');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('ignores the path component of a gs uri', async () => {
      await resolveBucket(getArtifactServiceFromUri('gs://my-bucket/prefix'));
      expect(bucketMock).toHaveBeenCalledWith('my-bucket');
      expect(bucketMock).not.toHaveBeenCalledWith('my-bucket/prefix');
    });

    it('warns that the path of a gs uri is ignored', () => {
      getArtifactServiceFromUri('gs://my-bucket/prefix');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0][0];
      expect(message).toContain('/prefix');
      expect(message).toContain('my-bucket');
    });

    it('does not warn for a gs uri with only a trailing slash', async () => {
      await resolveBucket(getArtifactServiceFromUri('gs://my-bucket/'));
      expect(bucketMock).toHaveBeenCalledWith('my-bucket');
      expect(warnSpy).not.toHaveBeenCalled();
    });
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
