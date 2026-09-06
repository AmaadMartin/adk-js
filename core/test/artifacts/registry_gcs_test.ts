/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getArtifactServiceFromUri} from '@google/adk';
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

describe('getArtifactServiceFromUri with a gs:// URI', () => {
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

  it('throws for a gs uri that names no bucket', () => {
    expect(() => getArtifactServiceFromUri('gs://')).toThrow(
      'Invalid artifact service URI: gs://. A gs:// URI must name a bucket',
    );
    expect(bucketMock).not.toHaveBeenCalled();
  });

  it('throws the same error for a gs uri that cannot be parsed', () => {
    expect(() => getArtifactServiceFromUri('gs://a b/c')).toThrow(
      'Invalid artifact service URI: gs://<unparseable URI, redacted>. A gs:// URI must name a bucket',
    );
    expect(bucketMock).not.toHaveBeenCalled();
  });

  it('redacts the password of a gs uri in the ignored-path warning', () => {
    getArtifactServiceFromUri('gs://admin:hunter2@my-bucket/prefix');
    expect(bucketMock).toHaveBeenCalledWith('my-bucket');
    const message = warnSpy.mock.calls[0][0];
    expect(message).toContain('gs://admin:***@my-bucket/prefix');
    expect(message).not.toContain('hunter2');
  });

  it('redacts the password of a gs uri in the invalid-uri error', () => {
    expect(() => getArtifactServiceFromUri('gs://admin:hunter2@')).toThrow(
      /gs:\/\/<unparseable URI, redacted>/,
    );
    expect(() => getArtifactServiceFromUri('gs://admin:hunter2@')).not.toThrow(
      /hunter2/,
    );
    expect(bucketMock).not.toHaveBeenCalled();
  });
});
