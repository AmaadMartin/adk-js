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

  describe('gs:// URIs', () => {
    let warnSpy: MockInstance<typeof logger.warn>;

    beforeEach(() => {
      bucketMock.mockClear();
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('passes the bucket name through for a gs uri without a path', () => {
      getArtifactServiceFromUri('gs://my-bucket');
      expect(bucketMock).toHaveBeenCalledWith('my-bucket');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('ignores the path component of a gs uri', () => {
      getArtifactServiceFromUri('gs://my-bucket/prefix');
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

    it('does not warn for a gs uri with only a trailing slash', () => {
      getArtifactServiceFromUri('gs://my-bucket/');
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
