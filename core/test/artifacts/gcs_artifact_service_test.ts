/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GcsArtifactService} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';

const {StorageMock, storageMock} = vi.hoisted(() => {
  class FakeGcsFile {
    constructor(
      public name: string,
      private bucket: FakeGcsBucket,
    ) {}

    async save(
      data: string | Buffer,
      options?: {
        contentType?: string;
        metadata?: {contentType?: string; metadata?: Record<string, unknown>};
      },
    ): Promise<void> {
      this.bucket.files.set(this.name, {
        data: Buffer.isBuffer(data) ? data : Buffer.from(data),
        metadata: options?.metadata?.metadata || {},
        contentType: options?.metadata?.contentType ?? options?.contentType,
        timeCreated: new Date().toISOString(),
      });
    }

    async download(): Promise<[Buffer]> {
      const file = this.bucket.files.get(this.name);
      if (!file) {
        throw new Error(`File not found: ${this.name}`);
      }
      return [file.data];
    }

    async getMetadata(): Promise<
      [
        {
          contentType?: string;
          metadata?: Record<string, unknown>;
          timeCreated?: string;
        },
      ]
    > {
      const file = this.bucket.files.get(this.name);
      if (!file) {
        throw new Error(`File not found: ${this.name}`);
      }
      return [
        {
          contentType: file.contentType,
          // GCS omits the key when the blob carries no metadata.
          metadata:
            Object.keys(file.metadata).length > 0 ? file.metadata : undefined,
          timeCreated: file.timeCreated,
        },
      ];
    }

    async delete(): Promise<void> {
      this.bucket.files.delete(this.name);
    }

    publicUrl(): string {
      return `https://storage.googleapis.com/${this.bucket.name}/${this.name}`;
    }
  }

  class FakeGcsBucket {
    files = new Map<
      string,
      {
        data: Buffer;
        metadata: Record<string, unknown>;
        contentType?: string;
        timeCreated?: string;
      }
    >();

    constructor(public name: string) {}

    file(name: string): FakeGcsFile {
      return new FakeGcsFile(name, this);
    }

    async getFiles(options?: {prefix?: string}): Promise<[FakeGcsFile[]]> {
      let files = Array.from(this.files.keys()).map((name) => this.file(name));
      if (options?.prefix) {
        files = files.filter((f) => f.name.startsWith(options.prefix!));
      }
      return [files];
    }
  }

  class FakeStorage {
    buckets = new Map<string, FakeGcsBucket>();

    bucket(name: string): FakeGcsBucket {
      if (!this.buckets.has(name)) {
        this.buckets.set(name, new FakeGcsBucket(name));
      }
      return this.buckets.get(name)!;
    }
  }

  const storageMock = new FakeStorage();
  const StorageMock = vi.fn(() => storageMock);
  return {StorageMock, storageMock};
});

vi.mock('@google-cloud/storage', () => {
  return {
    Storage: StorageMock,
  };
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

  describe('createTime', () => {
    const key = 'test-app/test-user/test-session/stamped.txt/0';

    const saveStamped = async (): Promise<GcsArtifactService> => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'stamped.txt',
        artifact: {text: 'hello'},
      });
      return service;
    };

    const readCreateTime = async (
      service: GcsArtifactService,
    ): Promise<number> => {
      const metadata = await service.getArtifactVersion({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'stamped.txt',
        version: 0,
      });
      if (!metadata) {
        expect.fail('Expected the saved version to report its metadata.');
      }
      return metadata.createTime;
    };

    it('reports the blob creation time in Unix seconds', async () => {
      const service = await saveStamped();
      const entry = storageMock.bucket(bucketName).files.get(key);
      if (!entry?.timeCreated) {
        expect.fail('Expected the stored blob to carry a creation time.');
      }
      // A time far from now, so the current time cannot pass for it.
      entry.timeCreated = '2020-01-02T03:04:05.000Z';

      expect(await readCreateTime(service)).toBe(1577934245);
    });

    it('falls back to the current time when the blob reports none', async () => {
      const service = await saveStamped();
      const entry = storageMock.bucket(bucketName).files.get(key);
      if (!entry) {
        expect.fail('Expected the blob to be stored.');
      }
      entry.timeCreated = undefined;

      const createTime = await readCreateTime(service);

      expect(createTime).toBeLessThanOrEqual(Date.now() / 1000 + 1);
      expect(createTime).toBeGreaterThan(0);
    });

    it('falls back to the current time when the blob reports a bad time', async () => {
      const service = await saveStamped();
      const entry = storageMock.bucket(bucketName).files.get(key);
      if (!entry) {
        expect.fail('Expected the blob to be stored.');
      }
      entry.timeCreated = 'not a timestamp';

      const createTime = await readCreateTime(service);

      expect(createTime).toBeLessThanOrEqual(Date.now() / 1000 + 1);
      expect(createTime).toBeGreaterThan(0);
    });
  });

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

    it('reports an empty customMetadata when the blob carries none', async () => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);

      await service.saveArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'bare.txt',
        artifact: {text: 'hello'},
      });
      const entry = storageMock
        .bucket(bucketName)
        .files.get('test-app/test-user/test-session/bare.txt/0');
      if (!entry) {
        expect.fail('Expected the blob to be stored.');
      }
      entry.metadata = {};

      const metadata = await service.getArtifactVersion({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'bare.txt',
        version: 0,
      });

      expect(metadata?.customMetadata).toEqual({});
    });

    it('reports only the caller keys as customMetadata', async () => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);

      await service.saveArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'note.txt',
        artifact: {text: 'hello'},
        customMetadata: {foo: 'bar'},
      });

      const metadata = await service.getArtifactVersion({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'note.txt',
        version: 0,
      });

      expect(metadata?.customMetadata).toEqual({foo: 'bar'});
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
