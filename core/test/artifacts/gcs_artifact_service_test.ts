/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GcsArtifactService} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';
import {fakeStorage as storageMock} from './fake_gcs_storage.js';

vi.mock('@google-cloud/storage', async () => {
  const {fakeStorage} = await import('./fake_gcs_storage.js');
  return {Storage: vi.fn(() => fakeStorage)};
});

describe('GcsArtifactService', () => {
  const bucketName = 'test-bucket';

  runArtifactServiceTests(
    async () => {
      storageMock.buckets.clear();
      return new GcsArtifactService(bucketName);
    },
    async () => {
      storageMock.buckets.clear();
    },
  );

  describe('customMetadata GCS shape', () => {
    it('stores customMetadata nested under metadata.metadata, not flat', async () => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);

      await service.saveArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'meta.txt',
        artifact: {text: 'hello'},
        customMetadata: {foo: 'bar'},
      });

      const entry = storageMock
        .bucket(bucketName)
        .files.get('test-app/test-user/test-session/meta.txt/0');

      expect(entry).toBeDefined();
      expect(entry?.metadata).toMatchObject({foo: 'bar'});
    });

    it('does not mutate the caller customMetadata object or leak ADK keys across saves', async () => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);
      const sharedMetadata = {env: 'prod'};

      await service.saveArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'pointer.pdf',
        artifact: {fileData: {fileUri: 'gs://my-bucket/pointer.pdf'}},
        customMetadata: sharedMetadata,
      });

      expect(sharedMetadata).toEqual({env: 'prod'});

      await service.saveArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'note.txt',
        artifact: {text: 'actual note content'},
        customMetadata: sharedMetadata,
      });

      const loaded = await service.loadArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'note.txt',
      });
      expect(loaded?.fileData).toBeUndefined();
      expect(loaded?.text).toBe('actual note content');
    });
  });

  describe('fileData GCS metadata', () => {
    it('stores fileData as a zero-byte blob with adkFileUri/adkFileMimeType metadata', async () => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);

      await service.saveArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'report.pdf',
        artifact: {
          fileData: {
            fileUri: 'gs://my-bucket/report.pdf',
            mimeType: 'application/pdf',
          },
        },
      });

      const entry = storageMock
        .bucket(bucketName)
        .files.get('test-app/test-user/test-session/report.pdf/0');

      expect(entry).toBeDefined();
      expect(entry?.data.length).toBe(0);
      expect(entry?.metadata['adkFileUri']).toBe('gs://my-bucket/report.pdf');
      expect(entry?.metadata['adkFileMimeType']).toBe('application/pdf');
    });

    it('falls back to blob contentType for mimeType when adkFileMimeType is absent', async () => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);

      storageMock
        .bucket(bucketName)
        .files.set('test-app/test-user/test-session/no_mime.pdf/0', {
          data: Buffer.alloc(0),
          metadata: {adkFileUri: 'gs://my-bucket/no_mime.pdf'},
          contentType: 'application/pdf',
        });

      const loaded = await service.loadArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'no_mime.pdf',
        version: 0,
      });

      expect(loaded?.fileData?.fileUri).toBe('gs://my-bucket/no_mime.pdf');
      expect(loaded?.fileData?.mimeType).toBe('application/pdf');
    });
  });

  describe('adkIsText / adkDisplayName GCS metadata', () => {
    it('flags text artifacts with adkIsText so they round-trip as text', async () => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);

      await service.saveArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'note.txt',
        artifact: {text: 'hello world'},
      });

      const entry = storageMock
        .bucket(bucketName)
        .files.get('test-app/test-user/test-session/note.txt/0');
      expect(entry?.metadata['adkIsText']).toBe('true');

      const loaded = await service.loadArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'note.txt',
      });
      expect(loaded?.text).toBe('hello world');
    });

    it('loads a pre-existing text artifact saved before adkIsText existed', async () => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);

      storageMock
        .bucket(bucketName)
        .files.set('test-app/test-user/test-session/old-note.txt/0', {
          data: Buffer.from('legacy text content'),
          metadata: {},
          contentType: 'text/plain',
        });

      const loaded = await service.loadArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'old-note.txt',
        version: 0,
      });

      expect(loaded?.text).toBe('legacy text content');
    });

    it('disambiguates an inlineData artifact with mimeType text/plain from a text artifact via displayName', async () => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);
      const data = Buffer.from('not a Part.text artifact').toString('base64');

      await service.saveArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'plain.txt',
        artifact: {
          inlineData: {data, mimeType: 'text/plain', displayName: 'plain.txt'},
        },
      });

      const entry = storageMock
        .bucket(bucketName)
        .files.get('test-app/test-user/test-session/plain.txt/0');
      expect(entry?.metadata['adkIsText']).toBeUndefined();

      const loaded = await service.loadArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'plain.txt',
      });
      expect(loaded?.text).toBeUndefined();
      expect(loaded?.inlineData?.data).toBe(data);
      expect(loaded?.inlineData?.mimeType).toBe('text/plain');
      expect(loaded?.inlineData?.displayName).toBe('plain.txt');
    });

    it('preserves an inlineData artifact with mimeType text/plain and no displayName as text', async () => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);
      const data = Buffer.from('ambiguous content').toString('base64');

      await service.saveArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'ambiguous.txt',
        artifact: {inlineData: {data, mimeType: 'text/plain'}},
      });

      const loaded = await service.loadArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'ambiguous.txt',
      });

      expect(loaded?.text).toBe('ambiguous content');
    });

    it('preserves inlineData.displayName across a save/load round trip', async () => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);
      const data = Buffer.from('some bytes').toString('base64');

      await service.saveArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'photo.png',
        artifact: {
          inlineData: {data, mimeType: 'image/png', displayName: 'photo.png'},
        },
      });

      const entry = storageMock
        .bucket(bucketName)
        .files.get('test-app/test-user/test-session/photo.png/0');
      expect(entry?.metadata['adkDisplayName']).toBe('photo.png');

      const loaded = await service.loadArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'photo.png',
      });
      expect(loaded?.inlineData?.data).toBe(data);
      expect(loaded?.inlineData?.mimeType).toBe('image/png');
      expect(loaded?.inlineData?.displayName).toBe('photo.png');
    });
  });
});
