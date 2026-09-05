/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GetSignedUrlConfig} from '@google-cloud/storage';
import {
  CompositeSessionKey,
  GcsArtifactService,
  InputValidationError,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';

const {StorageMock, storageMock, FAKE_TIME_CREATED, FakeGcsFile} = vi.hoisted(
  () => {
    /** The creation time the fake stamps on every object it stores. */
    const FAKE_TIME_CREATED = '2026-01-02T03:04:05.000Z';

    /** A missing object, reported the way the storage client reports one. */
    class FakeNotFoundError extends Error {
      readonly code = 404;
    }

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
          timeCreated: FAKE_TIME_CREATED,
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
          throw new FakeNotFoundError(`File not found: ${this.name}`);
        }
        return [
          {
            contentType: file.contentType,
            metadata: file.metadata,
            timeCreated: file.timeCreated,
          },
        ];
      }

      async getSignedUrl(config: GetSignedUrlConfig): Promise<[string]> {
        this.bucket.signedUrlCalls.push({objectName: this.name, config});
        return [`https://storage.example.com/${this.bucket.name}/${this.name}`];
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

      signedUrlCalls: Array<{objectName: string; config: GetSignedUrlConfig}> =
        [];

      constructor(public name: string) {}

      file(name: string): FakeGcsFile {
        return new FakeGcsFile(name, this);
      }

      async getFiles(options?: {prefix?: string}): Promise<[FakeGcsFile[]]> {
        let files = Array.from(this.files.keys()).map((name) =>
          this.file(name),
        );
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
    return {StorageMock, storageMock, FAKE_TIME_CREATED, FakeGcsFile};
  },
);

vi.mock('@google-cloud/storage', () => {
  return {
    Storage: StorageMock,
  };
});

const bucketName = 'test-bucket';
const scope: CompositeSessionKey = {
  appName: 'app',
  userId: 'user1',
  sessionId: 'sess1',
};
const filename = 'notes.txt';
const AUTHENTICATED_HOST = 'https://storage.cloud.google.com';
const ONE_HOUR_MS = 60 * 60 * 1000;
const SOURCE_REFERENCE_URI =
  'artifact://apps/app/users/user1/sessions/sess1/artifacts/source.txt/versions/0';
const SELF_REFERENCE_URI =
  'artifact://apps/app/users/user1/sessions/sess1/artifacts/loop.txt/versions/0';

/** Every row of the adk-python `INVALID_PATH_SEGMENT_CASES` table. */
const INVALID_PATH_SEGMENTS: Array<[string, string]> = [
  ['../escape', 'must not contain traversal segments'],
  ['../../etc', 'must not contain traversal segments'],
  ['foo/../../bar', 'must not contain traversal segments'],
  ['..', 'must not contain traversal segments'],
  ['.', 'must not contain traversal segments'],
  ['null\u0000byte', 'must not contain null bytes'],
  ['', 'must not be empty'],
  ['/etc/passwd', 'must not be an absolute path or start with a slash'],
  ['/leading/slash', 'must not be an absolute path or start with a slash'],
  [
    '\\leading\\backslash',
    'must not be an absolute path or start with a slash',
  ],
  ['C:\\absolute', 'must not be drive-qualified'],
  ['C:/absolute', 'must not be drive-qualified'],
  ['C:drive-relative', 'must not be drive-qualified'],
];

/** Saves `source.txt` and a `ref.txt` that points at it. */
async function saveReferenceChain(service: GcsArtifactService): Promise<void> {
  await service.saveArtifact({
    ...scope,
    filename: 'source.txt',
    artifact: {text: 'source content'},
  });
  await service.saveArtifact({
    ...scope,
    filename: 'ref.txt',
    artifact: {
      fileData: {fileUri: SOURCE_REFERENCE_URI, mimeType: 'text/plain'},
    },
  });
}

/** Saves `loop.txt` as a reference to itself. */
async function saveSelfReference(service: GcsArtifactService): Promise<void> {
  await service.saveArtifact({
    ...scope,
    filename: 'loop.txt',
    artifact: {
      fileData: {fileUri: SELF_REFERENCE_URI, mimeType: 'text/plain'},
    },
  });
}

/** Makes the next metadata read fail with something other than a 404. */
function failNextMetadataRead(): void {
  vi.spyOn(FakeGcsFile.prototype, 'getMetadata').mockRejectedValueOnce(
    new Error('storage is unreachable'),
  );
}

/** The one signing call the fake recorded, failing when there is not one. */
function onlySignedUrlCall(): {
  objectName: string;
  config: GetSignedUrlConfig;
} {
  const calls = storageMock.bucket(bucketName).signedUrlCalls;
  if (calls.length !== 1) {
    expect.fail(`expected exactly one signing call, got ${calls.length}`);
  }
  return calls[0];
}

describe('GcsArtifactService', () => {
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

    it('loads a pre-existing artifact saved under the legacy file_uri key', async () => {
      storageMock.buckets.clear();
      const service = new GcsArtifactService(bucketName);

      storageMock
        .bucket(bucketName)
        .files.set('test-app/test-user/test-session/legacy.pdf/0', {
          data: Buffer.alloc(0),
          metadata: {file_uri: 'gs://my-bucket/legacy.pdf'},
          contentType: 'application/pdf',
        });

      const loaded = await service.loadArtifact({
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: 'legacy.pdf',
        version: 0,
      });

      expect(loaded?.fileData?.fileUri).toBe('gs://my-bucket/legacy.pdf');
      expect(loaded?.fileData?.mimeType).toBe('application/pdf');
    });
  });

  describe('getAuthenticatedUrl', () => {
    beforeEach(() => {
      storageMock.buckets.clear();
    });

    it('addresses the latest version when the request names none', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({...scope, filename, artifact: {text: 'v0'}});
      await service.saveArtifact({...scope, filename, artifact: {text: 'v1'}});

      expect(await service.getAuthenticatedUrl({...scope, filename})).toBe(
        `${AUTHENTICATED_HOST}/${bucketName}/app/user1/sess1/notes.txt/1`,
      );
    });

    it('addresses the version the request names', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({...scope, filename, artifact: {text: 'v0'}});
      await service.saveArtifact({...scope, filename, artifact: {text: 'v1'}});

      expect(
        await service.getAuthenticatedUrl({...scope, filename, version: 0}),
      ).toBe(`${AUTHENTICATED_HOST}/${bucketName}/app/user1/sess1/notes.txt/0`);
    });

    it('returns undefined for an artifact that does not exist', async () => {
      const service = new GcsArtifactService(bucketName);

      expect(
        await service.getAuthenticatedUrl({
          ...scope,
          filename: 'nonexistent.txt',
        }),
      ).toBeUndefined();
    });

    it('percent-encodes the characters a URL reserves', async () => {
      const service = new GcsArtifactService(bucketName);
      const specialFilename = 'notes#1?v=100%real name.txt';
      await service.saveArtifact({
        ...scope,
        filename: specialFilename,
        artifact: {text: 'v0'},
      });

      expect(
        await service.getAuthenticatedUrl({
          ...scope,
          filename: specialFilename,
        }),
      ).toBe(
        `${AUTHENTICATED_HOST}/${bucketName}/app/user1/sess1/notes%231%3Fv%3D100%25real%20name.txt/0`,
      );
    });

    it('percent-encodes the characters encodeURIComponent keeps', async () => {
      const service = new GcsArtifactService(bucketName);
      const specialFilename = "a!b'c(d)e*f.txt";
      await service.saveArtifact({
        ...scope,
        filename: specialFilename,
        artifact: {text: 'v0'},
      });

      expect(
        await service.getAuthenticatedUrl({
          ...scope,
          filename: specialFilename,
        }),
      ).toBe(
        `${AUTHENTICATED_HOST}/${bucketName}/app/user1/sess1/a%21b%27c%28d%29e%2Af.txt/0`,
      );
    });

    it('addresses a user-scoped artifact under the user namespace', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({
        ...scope,
        filename: 'user:profile.png',
        artifact: {text: 'v0'},
      });

      expect(
        await service.getAuthenticatedUrl({
          ...scope,
          filename: 'user:profile.png',
        }),
      ).toBe(
        `${AUTHENTICATED_HOST}/${bucketName}/app/user1/user/profile.png/0`,
      );
    });

    it('addresses the target of an artifact reference', async () => {
      const service = new GcsArtifactService(bucketName);
      await saveReferenceChain(service);

      expect(
        await service.getAuthenticatedUrl({...scope, filename: 'ref.txt'}),
      ).toBe(
        `${AUTHENTICATED_HOST}/${bucketName}/app/user1/sess1/source.txt/0`,
      );
    });

    it('returns undefined for a pointer to a file it does not own', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({
        ...scope,
        filename: 'external.txt',
        artifact: {
          fileData: {
            fileUri: 'gs://other-bucket/foo.txt',
            mimeType: 'text/plain',
          },
        },
      });

      expect(
        await service.getAuthenticatedUrl({...scope, filename: 'external.txt'}),
      ).toBeUndefined();
    });

    it('rejects a self-referential artifact', async () => {
      const service = new GcsArtifactService(bucketName);
      await saveSelfReference(service);

      await expect(
        service.getAuthenticatedUrl({...scope, filename: 'loop.txt'}),
      ).rejects.toThrow(InputValidationError);
      await expect(
        service.getAuthenticatedUrl({...scope, filename: 'loop.txt'}),
      ).rejects.toThrow('Exceeded maximum recursion depth');
    });
  });

  describe('getSignedUrl', () => {
    beforeEach(() => {
      storageMock.buckets.clear();
    });

    it('signs a read that expires one hour out by default', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({...scope, filename, artifact: {text: 'v0'}});

      const before = Date.now();
      const url = await service.getSignedUrl({...scope, filename});
      const after = Date.now();

      expect(url).toBe(
        `https://storage.example.com/${bucketName}/app/user1/sess1/notes.txt/0`,
      );
      const call = onlySignedUrlCall();
      expect(call.config.action).toBe('read');
      const expires = call.config.expires;
      if (typeof expires !== 'number') {
        expect.fail(`expires must be a number, got ${typeof expires}`);
      }
      expect(expires).toBeGreaterThanOrEqual(before + ONE_HOUR_MS);
      expect(expires).toBeLessThanOrEqual(after + ONE_HOUR_MS);
    });

    it('forwards the signing options to the storage client', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({...scope, filename, artifact: {text: 'v0'}});

      await service.getSignedUrl({
        ...scope,
        filename,
        signingOptions: {version: 'v4', expires: 1893456000000},
      });

      const call = onlySignedUrlCall();
      expect(call.config.version).toBe('v4');
      expect(call.config.expires).toBe(1893456000000);
      expect(call.config.action).toBe('read');
    });

    it('returns undefined for an artifact that does not exist', async () => {
      const service = new GcsArtifactService(bucketName);

      expect(
        await service.getSignedUrl({...scope, filename: 'nonexistent.txt'}),
      ).toBeUndefined();
    });

    it('signs a user-scoped artifact under the user namespace', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({
        ...scope,
        filename: 'user:profile.png',
        artifact: {text: 'v0'},
      });

      await service.getSignedUrl({...scope, filename: 'user:profile.png'});

      expect(onlySignedUrlCall().objectName).toBe(
        'app/user1/user/profile.png/0',
      );
    });

    it('signs the target of an artifact reference', async () => {
      const service = new GcsArtifactService(bucketName);
      await saveReferenceChain(service);

      await service.getSignedUrl({...scope, filename: 'ref.txt'});

      expect(onlySignedUrlCall().objectName).toBe(
        'app/user1/sess1/source.txt/0',
      );
    });

    it('returns undefined for a pointer to a file it does not own', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({
        ...scope,
        filename: 'external.txt',
        artifact: {
          fileData: {
            fileUri: 'gs://other-bucket/foo.txt',
            mimeType: 'text/plain',
          },
        },
      });

      expect(
        await service.getSignedUrl({...scope, filename: 'external.txt'}),
      ).toBeUndefined();
      expect(storageMock.bucket(bucketName).signedUrlCalls).toHaveLength(0);
    });

    it('rejects a self-referential artifact', async () => {
      const service = new GcsArtifactService(bucketName);
      await saveSelfReference(service);

      await expect(
        service.getSignedUrl({...scope, filename: 'loop.txt'}),
      ).rejects.toThrow('Exceeded maximum recursion depth');
    });
  });

  describe('artifact references', () => {
    beforeEach(() => {
      storageMock.buckets.clear();
    });

    it('loads the target of a stored reference', async () => {
      const service = new GcsArtifactService(bucketName);
      await saveReferenceChain(service);

      const loaded = await service.loadArtifact({
        ...scope,
        filename: 'ref.txt',
      });

      expect(loaded).toEqual({text: 'source content'});
    });

    it('loads a user-scoped reference from another session of the same user', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({
        ...scope,
        filename: 'user:profile.txt',
        artifact: {text: 'profile'},
      });
      await service.saveArtifact({
        ...scope,
        sessionId: 'sess2',
        filename: 'ref.txt',
        artifact: {
          fileData: {
            fileUri:
              'artifact://apps/app/users/user1/artifacts/user:profile.txt/versions/0',
            mimeType: 'text/plain',
          },
        },
      });

      const loaded = await service.loadArtifact({
        ...scope,
        sessionId: 'sess2',
        filename: 'ref.txt',
      });

      expect(loaded).toEqual({text: 'profile'});
    });

    it('rejects a reference that names another user, on save', async () => {
      const service = new GcsArtifactService(bucketName);

      await expect(
        service.saveArtifact({
          ...scope,
          userId: 'attacker',
          filename: 'ref.txt',
          artifact: {
            fileData: {
              fileUri:
                'artifact://apps/app/users/victim/artifacts/user:secret.txt/versions/0',
            },
          },
        }),
      ).rejects.toThrow('same app and user scope');
    });

    it('rejects a reference that names another app, on save', async () => {
      const service = new GcsArtifactService(bucketName);

      await expect(
        service.saveArtifact({
          ...scope,
          appName: 'attacker-app',
          filename: 'ref.txt',
          artifact: {
            fileData: {
              fileUri:
                'artifact://apps/victim-app/users/user1/artifacts/user:secret.txt/versions/0',
            },
          },
        }),
      ).rejects.toThrow('same app and user scope');
    });

    it('rejects a stored reference rewritten to another session, on load', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({
        ...scope,
        sessionId: 'sess2',
        filename: 'source.txt',
        artifact: {text: 'other-session'},
      });
      await saveReferenceChain(service);

      const stored = storageMock
        .bucket(bucketName)
        .files.get('app/user1/sess1/ref.txt/0');
      if (!stored) {
        expect.fail('the reference artifact was not stored');
      }
      stored.metadata['adkFileUri'] =
        'artifact://apps/app/users/user1/sessions/sess2/artifacts/source.txt/versions/0';

      await expect(
        service.loadArtifact({...scope, filename: 'ref.txt'}),
      ).rejects.toThrow('same session scope');
    });

    it('rejects a reference to a session-scoped artifact with no session', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({
        ...scope,
        filename: 'ref.txt',
        artifact: {
          fileData: {
            fileUri:
              'artifact://apps/app/users/user1/artifacts/source.txt/versions/0',
          },
        },
      });

      await expect(
        service.loadArtifact({...scope, filename: 'ref.txt'}),
      ).rejects.toThrow(
        'Session ID must be provided for session-scoped artifacts.',
      );
    });

    it('rejects a self-referential artifact, on load', async () => {
      const service = new GcsArtifactService(bucketName);
      await saveSelfReference(service);

      await expect(
        service.loadArtifact({...scope, filename: 'loop.txt'}),
      ).rejects.toThrow('Exceeded maximum recursion depth');
    });

    it('rejects a reference URI that does not parse, on save', async () => {
      const service = new GcsArtifactService(bucketName);

      await expect(
        service.saveArtifact({
          ...scope,
          filename: 'invalid_ref.txt',
          artifact: {
            fileData: {
              fileUri: 'artifact://apps/app/invalid',
              mimeType: 'text/plain',
            },
          },
        }),
      ).rejects.toThrow(
        'Invalid artifact reference URI: artifact://apps/app/invalid',
      );
    });

    it('rejects a reference URI that does not parse, on load', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({
        ...scope,
        filename: 'broken.txt',
        artifact: {text: 'v0'},
      });
      const stored = storageMock
        .bucket(bucketName)
        .files.get('app/user1/sess1/broken.txt/0');
      if (!stored) {
        expect.fail('the artifact was not stored');
      }
      stored.metadata['adkFileUri'] = 'artifact://apps/app/invalid';

      await expect(
        service.loadArtifact({...scope, filename: 'broken.txt'}),
      ).rejects.toThrow('Invalid artifact reference URI');
    });

    it('rejects fileData that carries no fileUri', async () => {
      const service = new GcsArtifactService(bucketName);

      await expect(
        service.saveArtifact({
          ...scope,
          filename: 'empty.bin',
          artifact: {fileData: {fileUri: ''}},
        }),
      ).rejects.toThrow(InputValidationError);
    });
  });

  describe('path segment validation', () => {
    const operations: Array<
      [
        string,
        (
          service: GcsArtifactService,
          key: CompositeSessionKey,
        ) => Promise<unknown>,
      ]
    > = [
      [
        'saveArtifact',
        (service, key) =>
          service.saveArtifact({...key, filename, artifact: {text: 'v0'}}),
      ],
      [
        'loadArtifact',
        (service, key) => service.loadArtifact({...key, filename}),
      ],
      [
        'deleteArtifact',
        (service, key) => service.deleteArtifact({...key, filename}),
      ],
      ['listArtifactKeys', (service, key) => service.listArtifactKeys(key)],
      [
        'getArtifactVersion',
        (service, key) => service.getArtifactVersion({...key, filename}),
      ],
    ];

    describe.each(operations)('%s', (_operation, run) => {
      describe.each(['appName', 'userId', 'sessionId'] as const)(
        'rejects %s',
        (field) => {
          it.each(INVALID_PATH_SEGMENTS)('%s', async (value, fragment) => {
            storageMock.buckets.clear();
            const service = new GcsArtifactService(bucketName);
            const key = {...scope, [field]: value};

            await expect(run(service, key)).rejects.toThrow(
              InputValidationError,
            );
            await expect(run(service, key)).rejects.toThrow(fragment);
          });
        },
      );
    });
  });

  describe('version listing', () => {
    beforeEach(() => {
      storageMock.buckets.clear();
    });

    it('ignores a stored object whose name does not end in a version', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({...scope, filename, artifact: {text: 'v0'}});
      storageMock
        .bucket(bucketName)
        .files.set('app/user1/sess1/notes.txt/checkpoint', {
          data: Buffer.alloc(0),
          metadata: {},
          contentType: 'text/plain',
        });

      expect(await service.listVersions({...scope, filename})).toEqual([0]);
    });

    it('lists an object stored directly under the session prefix', async () => {
      const service = new GcsArtifactService(bucketName);
      storageMock.bucket(bucketName).files.set('app/user1/sess1/orphan', {
        data: Buffer.alloc(0),
        metadata: {},
      });

      expect(await service.listArtifactKeys(scope)).toEqual(['orphan']);
    });

    it('keeps the versions of a nested artifact out of its parent', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({
        ...scope,
        filename: 'doc',
        artifact: {text: 'parent v0'},
      });
      for (const version of [0, 1, 2]) {
        await service.saveArtifact({
          ...scope,
          filename: 'doc/nested',
          artifact: {text: `nested v${version}`},
        });
      }

      expect(await service.listVersions({...scope, filename: 'doc'})).toEqual([
        0,
      ]);
      expect(await service.loadArtifact({...scope, filename: 'doc'})).toEqual({
        text: 'parent v0',
      });
    });
  });

  describe('ArtifactVersion metadata', () => {
    beforeEach(() => {
      storageMock.buckets.clear();
    });

    it('reports the canonical gs:// URI and the creation time', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({...scope, filename, artifact: {text: 'v0'}});

      const artifactVersion = await service.getArtifactVersion({
        ...scope,
        filename,
      });

      expect(artifactVersion?.canonicalUri).toBe(
        `gs://${bucketName}/app/user1/sess1/notes.txt/0`,
      );
      expect(artifactVersion?.createTime).toBe(
        Date.parse(FAKE_TIME_CREATED) / 1000,
      );
    });

    it('reports no creation time when the object carries none', async () => {
      const service = new GcsArtifactService(bucketName);
      storageMock.bucket(bucketName).files.set('app/user1/sess1/notes.txt/0', {
        data: Buffer.from('v0'),
        metadata: {},
        contentType: 'text/plain',
      });

      const artifactVersion = await service.getArtifactVersion({
        ...scope,
        filename,
      });

      expect(artifactVersion?.version).toBe(0);
      expect(artifactVersion?.createTime).toBeUndefined();
    });

    it('reports no creation time when the object reports an unparseable one', async () => {
      const service = new GcsArtifactService(bucketName);
      storageMock.bucket(bucketName).files.set('app/user1/sess1/notes.txt/0', {
        data: Buffer.from('v0'),
        metadata: {},
        contentType: 'text/plain',
        timeCreated: 'not a timestamp',
      });

      expect(
        (await service.getArtifactVersion({...scope, filename}))?.createTime,
      ).toBeUndefined();
    });

    it('carries both fields on every version, in ascending order', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({...scope, filename, artifact: {text: 'v0'}});
      await service.saveArtifact({...scope, filename, artifact: {text: 'v1'}});

      expect(await service.listArtifactVersions({...scope, filename})).toEqual([
        {
          version: 0,
          mimeType: 'text/plain',
          customMetadata: {adkIsText: 'true'},
          canonicalUri: `gs://${bucketName}/app/user1/sess1/notes.txt/0`,
          createTime: Date.parse(FAKE_TIME_CREATED) / 1000,
        },
        {
          version: 1,
          mimeType: 'text/plain',
          customMetadata: {adkIsText: 'true'},
          canonicalUri: `gs://${bucketName}/app/user1/sess1/notes.txt/1`,
          createTime: Date.parse(FAKE_TIME_CREATED) / 1000,
        },
      ]);
    });

    it('reports a storage failure that is not a missing object as no version', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({...scope, filename, artifact: {text: 'v0'}});
      failNextMetadataRead();

      expect(
        await service.getArtifactVersion({...scope, filename, version: 0}),
      ).toBeUndefined();
    });
  });

  describe('storage failures that are not a missing object', () => {
    beforeEach(() => {
      storageMock.buckets.clear();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reports a failed metadata read as an absent artifact', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({...scope, filename, artifact: {text: 'v0'}});
      failNextMetadataRead();

      expect(
        await service.loadArtifact({...scope, filename, version: 0}),
      ).toBeUndefined();
    });

    it('raises a failed metadata read out of getAuthenticatedUrl', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({...scope, filename, artifact: {text: 'v0'}});
      failNextMetadataRead();

      await expect(
        service.getAuthenticatedUrl({...scope, filename, version: 0}),
      ).rejects.toThrow('storage is unreachable');
    });

    it('raises a failed metadata read out of getSignedUrl', async () => {
      const service = new GcsArtifactService(bucketName);
      await service.saveArtifact({...scope, filename, artifact: {text: 'v0'}});
      failNextMetadataRead();

      await expect(
        service.getSignedUrl({...scope, filename, version: 0}),
      ).rejects.toThrow('storage is unreachable');
    });
  });
});
