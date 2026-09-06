/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GetSignedUrlConfig} from '@google-cloud/storage';
import {
  GcsArtifactService,
  getArtifactUri,
  InputValidationError,
  type CompositeSessionKey,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';

const {StorageMock, storageMock, TIME_CREATED} = vi.hoisted(() => {
  /** A fixed creation time, so createTime assertions are deterministic. */
  const TIME_CREATED = '2026-01-02T03:04:05.000Z';

  /** Mirrors the 404 ApiError the storage client raises for a missing object. */
  class FakeNotFoundError extends Error {
    readonly code = 404;

    constructor(objectName: string) {
      super(`File not found: ${objectName}`);
    }
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
        timeCreated: TIME_CREATED,
      });
    }

    async download(): Promise<[Buffer]> {
      const file = this.bucket.files.get(this.name);
      if (!file) {
        throw new FakeNotFoundError(this.name);
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
      const failure = this.bucket.failures.get(this.name);
      if (failure) {
        throw failure;
      }
      const file = this.bucket.files.get(this.name);
      if (!file) {
        throw new FakeNotFoundError(this.name);
      }
      // GCS omits the custom metadata field when an object carries none.
      const hasCustomMetadata = Object.keys(file.metadata).length > 0;
      return [
        {
          contentType: file.contentType,
          metadata: hasCustomMetadata ? file.metadata : undefined,
          timeCreated: file.timeCreated,
        },
      ];
    }

    async getSignedUrl(config: GetSignedUrlConfig): Promise<[string]> {
      const file = this.bucket.files.get(this.name);
      if (!file) {
        throw new FakeNotFoundError(this.name);
      }
      this.bucket.signedUrlCalls.push({name: this.name, config});
      return [
        `https://storage.example.com/${this.bucket.name}/${this.name}?signed=true`,
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

    signedUrlCalls: Array<{name: string; config: GetSignedUrlConfig}> = [];

    /** Errors the storage client raises for an object, keyed by object name. */
    failures = new Map<string, Error>();

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
  return {StorageMock, storageMock, TIME_CREATED};
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

const BUCKET = 'test-bucket';
const APP = 'test-app';
const USER = 'test-user';
const SESSION = 'test-session';
const SESSION_KEY = {appName: APP, userId: USER, sessionId: SESSION};
const ONE_HOUR_MS = 60 * 60 * 1000;

/** Returns a service backed by an empty bucket. */
function newService(): GcsArtifactService {
  storageMock.buckets.clear();
  return new GcsArtifactService(BUCKET);
}

/** Writes an object into the bucket, bypassing the service. */
function putObject(name: string, metadata: Record<string, unknown>): void {
  storageMock.bucket(BUCKET).files.set(name, {
    data: Buffer.alloc(0),
    metadata,
  });
}

describe('GcsArtifactService.getAuthenticatedUrl', () => {
  it('links to the latest version', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v1'},
    });

    await expect(
      service.getAuthenticatedUrl({...SESSION_KEY, filename: 'notes.txt'}),
    ).resolves.toBe(
      'https://storage.cloud.google.com/test-bucket/test-app/test-user/test-session/notes.txt/1',
    );
  });

  it('links to an explicit version', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v1'},
    });

    await expect(
      service.getAuthenticatedUrl({
        ...SESSION_KEY,
        filename: 'notes.txt',
        version: 0,
      }),
    ).resolves.toBe(
      'https://storage.cloud.google.com/test-bucket/test-app/test-user/test-session/notes.txt/0',
    );
  });

  it('returns undefined for a missing artifact', async () => {
    const service = newService();

    await expect(
      service.getAuthenticatedUrl({...SESSION_KEY, filename: 'absent.txt'}),
    ).resolves.toBeUndefined();
  });

  it('returns undefined for a missing version of an existing artifact', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });

    await expect(
      service.getAuthenticatedUrl({
        ...SESSION_KEY,
        filename: 'notes.txt',
        version: 7,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when the target of a reference was deleted', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'source.txt',
      artifact: {text: 'source content'},
    });
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'pointer.txt',
      artifact: {
        fileData: {
          fileUri: getArtifactUri({
            ...SESSION_KEY,
            filename: 'source.txt',
            version: 0,
          }),
        },
      },
    });
    await service.deleteArtifact({...SESSION_KEY, filename: 'source.txt'});

    await expect(
      service.getAuthenticatedUrl({...SESSION_KEY, filename: 'pointer.txt'}),
    ).resolves.toBeUndefined();
  });

  it('propagates a storage error that is not a missing object', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    storageMock
      .bucket(BUCKET)
      .failures.set(
        'test-app/test-user/test-session/notes.txt/0',
        new Error('permission denied'),
      );

    await expect(
      service.getAuthenticatedUrl({...SESSION_KEY, filename: 'notes.txt'}),
    ).rejects.toThrow('permission denied');
  });

  it('percent-encodes characters that would change the URL', async () => {
    const service = newService();
    const filename = 'notes#1?v=100%real name.txt';
    await service.saveArtifact({
      ...SESSION_KEY,
      filename,
      artifact: {text: 'v0'},
    });

    await expect(
      service.getAuthenticatedUrl({...SESSION_KEY, filename}),
    ).resolves.toBe(
      'https://storage.cloud.google.com/test-bucket/test-app/test-user/test-session/notes%231%3Fv%3D100%25real%20name.txt/0',
    );
  });

  it('percent-encodes the characters encodeURIComponent leaves alone', async () => {
    const service = newService();
    const filename = "report(final)!*'.txt";
    await service.saveArtifact({
      ...SESSION_KEY,
      filename,
      artifact: {text: 'v0'},
    });

    await expect(
      service.getAuthenticatedUrl({...SESSION_KEY, filename}),
    ).resolves.toBe(
      'https://storage.cloud.google.com/test-bucket/test-app/test-user/test-session/report%28final%29%21%2A%27.txt/0',
    );
  });

  it('links a user-scoped artifact under the user namespace', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'user:prefs.json',
      artifact: {text: '{}'},
    });

    await expect(
      service.getAuthenticatedUrl({
        ...SESSION_KEY,
        filename: 'user:prefs.json',
      }),
    ).resolves.toBe(
      'https://storage.cloud.google.com/test-bucket/test-app/test-user/user/prefs.json/0',
    );
  });

  it('links the source object of an artifact reference', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'source.txt',
      artifact: {text: 'source content'},
    });
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'pointer.txt',
      artifact: {
        fileData: {
          fileUri: getArtifactUri({
            ...SESSION_KEY,
            filename: 'source.txt',
            version: 0,
          }),
        },
      },
    });

    await expect(
      service.getAuthenticatedUrl({...SESSION_KEY, filename: 'pointer.txt'}),
    ).resolves.toBe(
      'https://storage.cloud.google.com/test-bucket/test-app/test-user/test-session/source.txt/0',
    );
  });

  it('returns undefined for a pointer to a file outside this service', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'external.pdf',
      artifact: {fileData: {fileUri: 'gs://other-bucket/foo.txt'}},
    });

    await expect(
      service.getAuthenticatedUrl({...SESSION_KEY, filename: 'external.pdf'}),
    ).resolves.toBeUndefined();
  });

  it('rejects a self-referencing pointer', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'loop.txt',
      artifact: {
        fileData: {
          fileUri: getArtifactUri({
            ...SESSION_KEY,
            filename: 'loop.txt',
            version: 0,
          }),
        },
      },
    });

    await expect(
      service.getAuthenticatedUrl({...SESSION_KEY, filename: 'loop.txt'}),
    ).rejects.toThrow(/Exceeded maximum recursion depth/);
  });
});

describe('GcsArtifactService.getSignedUrl', () => {
  it('signs the latest version with a read action and a one hour expiry', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v1'},
    });

    const before = Date.now();
    const url = await service.getSignedUrl({
      ...SESSION_KEY,
      filename: 'notes.txt',
    });
    const after = Date.now();

    expect(url).toBe(
      'https://storage.example.com/test-bucket/test-app/test-user/test-session/notes.txt/1?signed=true',
    );
    const calls = storageMock.bucket(BUCKET).signedUrlCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0].config.action).toBe('read');
    expect(calls[0].config.version).toBeUndefined();
    expect(calls[0].config.expires).toBeGreaterThanOrEqual(
      before + ONE_HOUR_MS,
    );
    expect(calls[0].config.expires).toBeLessThanOrEqual(after + ONE_HOUR_MS);
  });

  it('forwards the signing version and signs an explicit version', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v1'},
    });

    await service.getSignedUrl({
      ...SESSION_KEY,
      filename: 'notes.txt',
      version: 0,
      signingOptions: {version: 'v4'},
    });

    const [call] = storageMock.bucket(BUCKET).signedUrlCalls;
    expect(call.name).toBe('test-app/test-user/test-session/notes.txt/0');
    expect(call.config.version).toBe('v4');
  });

  it('forwards every signing option', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    const expires = new Date('2026-03-04T05:06:07.000Z');

    await service.getSignedUrl({
      ...SESSION_KEY,
      filename: 'notes.txt',
      signingOptions: {
        expires,
        action: 'write',
        responseType: 'application/pdf',
        promptSaveAs: 'notes.txt',
      },
    });

    const [call] = storageMock.bucket(BUCKET).signedUrlCalls;
    expect(call.config).toEqual({
      action: 'write',
      expires,
      responseType: 'application/pdf',
      promptSaveAs: 'notes.txt',
    });
  });

  it('lets a signing option override the default action', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });

    await service.getSignedUrl({
      ...SESSION_KEY,
      filename: 'notes.txt',
      signingOptions: {action: 'delete', version: 'v2'},
    });

    const [call] = storageMock.bucket(BUCKET).signedUrlCalls;
    expect(call.config.action).toBe('delete');
    expect(call.config.version).toBe('v2');
  });

  it('lets a signing option override the default expiry', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    const expires = new Date('2020-01-01T00:00:00.000Z');

    await service.getSignedUrl({
      ...SESSION_KEY,
      filename: 'notes.txt',
      signingOptions: {expires},
    });

    const [call] = storageMock.bucket(BUCKET).signedUrlCalls;
    expect(call.config.expires).toBe(expires);
  });

  it('returns undefined for a missing artifact', async () => {
    const service = newService();

    await expect(
      service.getSignedUrl({...SESSION_KEY, filename: 'absent.txt'}),
    ).resolves.toBeUndefined();
    expect(storageMock.bucket(BUCKET).signedUrlCalls).toHaveLength(0);
  });

  it('returns undefined for a missing version of an existing artifact', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });

    await expect(
      service.getSignedUrl({...SESSION_KEY, filename: 'notes.txt', version: 7}),
    ).resolves.toBeUndefined();
    expect(storageMock.bucket(BUCKET).signedUrlCalls).toHaveLength(0);
  });

  it('signs the source object of an artifact reference', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'source.txt',
      artifact: {text: 'source content'},
    });
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'pointer.txt',
      artifact: {
        fileData: {
          fileUri: getArtifactUri({
            ...SESSION_KEY,
            filename: 'source.txt',
            version: 0,
          }),
        },
      },
    });

    await expect(
      service.getSignedUrl({...SESSION_KEY, filename: 'pointer.txt'}),
    ).resolves.toBe(
      'https://storage.example.com/test-bucket/test-app/test-user/test-session/source.txt/0?signed=true',
    );
  });

  it('returns undefined for a pointer to a file outside this service', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'external.pdf',
      artifact: {fileData: {fileUri: 'gs://other-bucket/foo.txt'}},
    });

    await expect(
      service.getSignedUrl({...SESSION_KEY, filename: 'external.pdf'}),
    ).resolves.toBeUndefined();
  });

  it('signs a user-scoped artifact', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'user:prefs.json',
      artifact: {text: '{}'},
    });

    await expect(
      service.getSignedUrl({...SESSION_KEY, filename: 'user:prefs.json'}),
    ).resolves.toBe(
      'https://storage.example.com/test-bucket/test-app/test-user/user/prefs.json/0?signed=true',
    );
  });

  it('rejects a self-referencing pointer', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'loop.txt',
      artifact: {
        fileData: {
          fileUri: getArtifactUri({
            ...SESSION_KEY,
            filename: 'loop.txt',
            version: 0,
          }),
        },
      },
    });

    await expect(
      service.getSignedUrl({...SESSION_KEY, filename: 'loop.txt'}),
    ).rejects.toThrow(/Exceeded maximum recursion depth/);
  });
});

describe('GcsArtifactService artifact references', () => {
  it('loads the source content through a pointer', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'source.txt',
      artifact: {text: 'source content'},
    });
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'pointer.txt',
      artifact: {
        fileData: {
          fileUri: getArtifactUri({
            ...SESSION_KEY,
            filename: 'source.txt',
            version: 0,
          }),
        },
      },
    });

    const loaded = await service.loadArtifact({
      ...SESSION_KEY,
      filename: 'pointer.txt',
    });

    expect(loaded?.text).toBe('source content');
    expect(loaded?.fileData).toBeUndefined();
  });

  it('follows a chain of five references', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'hop0.txt',
      artifact: {text: 'end of the chain'},
    });
    for (let hop = 1; hop <= 5; hop++) {
      await service.saveArtifact({
        ...SESSION_KEY,
        filename: `hop${hop}.txt`,
        artifact: {
          fileData: {
            fileUri: getArtifactUri({
              ...SESSION_KEY,
              filename: `hop${hop - 1}.txt`,
              version: 0,
            }),
          },
        },
      });
    }

    const loaded = await service.loadArtifact({
      ...SESSION_KEY,
      filename: 'hop5.txt',
    });

    expect(loaded?.text).toBe('end of the chain');
  });

  it('rejects a chain of six references', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'hop0.txt',
      artifact: {text: 'end of the chain'},
    });
    for (let hop = 1; hop <= 6; hop++) {
      await service.saveArtifact({
        ...SESSION_KEY,
        filename: `hop${hop}.txt`,
        artifact: {
          fileData: {
            fileUri: getArtifactUri({
              ...SESSION_KEY,
              filename: `hop${hop - 1}.txt`,
              version: 0,
            }),
          },
        },
      });
    }

    await expect(
      service.loadArtifact({...SESSION_KEY, filename: 'hop6.txt'}),
    ).rejects.toThrow(/Exceeded maximum recursion depth/);
  });

  it('rejects a malformed reference on save', async () => {
    const service = newService();

    await expect(
      service.saveArtifact({
        ...SESSION_KEY,
        filename: 'pointer.txt',
        artifact: {fileData: {fileUri: 'artifact://apps/app/invalid'}},
      }),
    ).rejects.toThrow(InputValidationError);
  });

  it('reports the malformed reference URI', async () => {
    const service = newService();

    await expect(
      service.saveArtifact({
        ...SESSION_KEY,
        filename: 'pointer.txt',
        artifact: {fileData: {fileUri: 'artifact://apps/app/invalid'}},
      }),
    ).rejects.toThrow(
      'Invalid artifact reference URI: artifact://apps/app/invalid',
    );
  });

  it('rejects fileData without a file URI', async () => {
    const service = newService();

    await expect(
      service.saveArtifact({
        ...SESSION_KEY,
        filename: 'pointer.txt',
        artifact: {fileData: {fileUri: ''}},
      }),
    ).rejects.toThrow(InputValidationError);
  });

  it.each([
    [
      'another user',
      'artifact://apps/test-app/users/other-user/artifacts/secret.txt/versions/0',
    ],
    [
      'another app',
      'artifact://apps/other-app/users/test-user/artifacts/secret.txt/versions/0',
    ],
  ])('rejects a reference owned by %s on save', async (_name, fileUri) => {
    const service = newService();

    await expect(
      service.saveArtifact({
        ...SESSION_KEY,
        filename: 'pointer.txt',
        artifact: {fileData: {fileUri}},
      }),
    ).rejects.toThrow(/same app and user scope/);
  });

  it('loads a user-scoped reference from another session', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'user:shared.txt',
      artifact: {text: 'shared content'},
    });
    await service.saveArtifact({
      appName: APP,
      userId: USER,
      sessionId: 'other-session',
      filename: 'pointer.txt',
      artifact: {
        fileData: {
          fileUri: getArtifactUri({
            appName: APP,
            userId: USER,
            filename: 'user:shared.txt',
            version: 0,
          }),
        },
      },
    });

    const loaded = await service.loadArtifact({
      appName: APP,
      userId: USER,
      sessionId: 'other-session',
      filename: 'pointer.txt',
    });

    expect(loaded?.text).toBe('shared content');
  });

  it('rejects a stored reference that cannot be parsed', async () => {
    const service = newService();
    putObject('test-app/test-user/test-session/pointer.txt/0', {
      adkFileUri: 'artifact://apps/test-app/invalid',
    });

    await expect(
      service.loadArtifact({...SESSION_KEY, filename: 'pointer.txt'}),
    ).rejects.toThrow(
      'Invalid artifact reference URI: artifact://apps/test-app/invalid',
    );
  });

  it('rejects a stored reference that names another session', async () => {
    const service = newService();
    putObject('test-app/test-user/test-session/pointer.txt/0', {
      adkFileUri:
        'artifact://apps/test-app/users/test-user/sessions/other-session/artifacts/secret.txt/versions/0',
    });

    await expect(
      service.loadArtifact({...SESSION_KEY, filename: 'pointer.txt'}),
    ).rejects.toThrow(/same session scope/);
  });

  it('rejects a user-scoped reference to a session-scoped artifact', async () => {
    const service = newService();
    putObject('test-app/test-user/test-session/pointer.txt/0', {
      adkFileUri:
        'artifact://apps/test-app/users/test-user/artifacts/plain.txt/versions/0',
    });

    await expect(
      service.loadArtifact({...SESSION_KEY, filename: 'pointer.txt'}),
    ).rejects.toThrow(
      'Session ID must be provided for session-scoped artifacts.',
    );
  });

  it('reports a storage error as a missing artifact on load', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    storageMock
      .bucket(BUCKET)
      .failures.set(
        'test-app/test-user/test-session/notes.txt/0',
        new Error('permission denied'),
      );

    await expect(
      service.loadArtifact({...SESSION_KEY, filename: 'notes.txt', version: 0}),
    ).resolves.toBeUndefined();
  });

  it('loads an object that carries no custom metadata', async () => {
    const service = newService();
    storageMock
      .bucket(BUCKET)
      .files.set('test-app/test-user/test-session/plain.txt/0', {
        data: Buffer.from('plain bytes'),
        metadata: {},
        contentType: 'text/plain',
      });

    const loaded = await service.loadArtifact({
      ...SESSION_KEY,
      filename: 'plain.txt',
    });

    expect(loaded?.text).toBe('plain bytes');
  });

  it('keeps a pointer to a file outside this service as fileData', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'external.pdf',
      artifact: {
        fileData: {
          fileUri: 'gs://other-bucket/foo.pdf',
          mimeType: 'application/pdf',
        },
      },
    });

    const loaded = await service.loadArtifact({
      ...SESSION_KEY,
      filename: 'external.pdf',
    });

    expect(loaded?.fileData?.fileUri).toBe('gs://other-bucket/foo.pdf');
    expect(loaded?.fileData?.mimeType).toBe('application/pdf');
  });
});

describe('GcsArtifactService version parsing', () => {
  it('sorts versions numerically past nine', async () => {
    const service = newService();
    for (let version = 0; version < 12; version++) {
      await service.saveArtifact({
        ...SESSION_KEY,
        filename: 'notes.txt',
        artifact: {text: `v${version}`},
      });
    }

    await expect(
      service.listVersions({...SESSION_KEY, filename: 'notes.txt'}),
    ).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('skips an object whose suffix is not a version', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    putObject('test-app/test-user/test-session/notes.txt/checkpoint', {});

    await expect(
      service.listVersions({...SESSION_KEY, filename: 'notes.txt'}),
    ).resolves.toEqual([0]);
  });

  it('skips a suffix that only starts with digits', async () => {
    const service = newService();
    putObject('test-app/test-user/test-session/notes.txt/3abc', {});

    await expect(
      service.listVersions({...SESSION_KEY, filename: 'notes.txt'}),
    ).resolves.toEqual([]);
  });

  it('excludes a nested artifact from the parent versions', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt/attachments/report.pdf',
      artifact: {text: 'nested'},
    });

    await expect(
      service.listVersions({...SESSION_KEY, filename: 'notes.txt'}),
    ).resolves.toEqual([0]);
  });

  it('excludes a nested artifact from the parent version metadata', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt/attachments/report.pdf',
      artifact: {text: 'nested'},
    });

    const versions = await service.listArtifactVersions({
      ...SESSION_KEY,
      filename: 'notes.txt',
    });

    expect(versions.map((version) => version.canonicalUri)).toEqual([
      'gs://test-bucket/test-app/test-user/test-session/notes.txt/0',
    ]);
  });
});

describe('GcsArtifactService.listArtifactKeys', () => {
  it('lists session-scoped and user-scoped keys together', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'user:prefs.json',
      artifact: {text: '{}'},
    });

    await expect(service.listArtifactKeys(SESSION_KEY)).resolves.toEqual([
      'notes.txt',
      'user:prefs.json',
    ]);
  });

  it('reports an object stored without a version suffix', async () => {
    const service = newService();
    putObject('test-app/test-user/test-session/stray', {});

    await expect(service.listArtifactKeys(SESSION_KEY)).resolves.toEqual([
      'stray',
    ]);
  });
});

describe('GcsArtifactService version metadata', () => {
  it('reports the gs:// canonical URI', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });

    const version = await service.getArtifactVersion({
      ...SESSION_KEY,
      filename: 'notes.txt',
    });

    expect(version?.canonicalUri).toBe(
      'gs://test-bucket/test-app/test-user/test-session/notes.txt/0',
    );
  });

  it('reports the creation time in seconds', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });

    const version = await service.getArtifactVersion({
      ...SESSION_KEY,
      filename: 'notes.txt',
    });

    expect(version?.createTime).toBe(Date.parse(TIME_CREATED) / 1000);
  });

  it('omits the creation time when the object has none', async () => {
    const service = newService();
    putObject('test-app/test-user/test-session/notes.txt/0', {});

    const version = await service.getArtifactVersion({
      ...SESSION_KEY,
      filename: 'notes.txt',
    });

    expect(version?.version).toBe(0);
    expect(version?.createTime).toBeUndefined();
  });

  it('omits the creation time when the timestamp cannot be read', async () => {
    const service = newService();
    storageMock
      .bucket(BUCKET)
      .files.set('test-app/test-user/test-session/notes.txt/0', {
        data: Buffer.alloc(0),
        metadata: {},
        timeCreated: 'not a timestamp',
      });

    const version = await service.getArtifactVersion({
      ...SESSION_KEY,
      filename: 'notes.txt',
    });

    expect(version?.createTime).toBeUndefined();
  });

  it('returns undefined for a missing version', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });

    await expect(
      service.getArtifactVersion({
        ...SESSION_KEY,
        filename: 'notes.txt',
        version: 7,
      }),
    ).resolves.toBeUndefined();
  });

  it('reports a storage error as missing version metadata', async () => {
    const service = newService();
    await service.saveArtifact({
      ...SESSION_KEY,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });
    storageMock
      .bucket(BUCKET)
      .failures.set(
        'test-app/test-user/test-session/notes.txt/0',
        new Error('permission denied'),
      );

    await expect(
      service.getArtifactVersion({
        ...SESSION_KEY,
        filename: 'notes.txt',
        version: 0,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('GcsArtifactService path segment validation', () => {
  const OPERATIONS: Array<
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
        service.saveArtifact({
          ...key,
          filename: 'notes.txt',
          artifact: {text: 'v0'},
        }),
    ],
    [
      'loadArtifact',
      (service, key) => service.loadArtifact({...key, filename: 'notes.txt'}),
    ],
    [
      'deleteArtifact',
      (service, key) => service.deleteArtifact({...key, filename: 'notes.txt'}),
    ],
    [
      'listVersions',
      (service, key) => service.listVersions({...key, filename: 'notes.txt'}),
    ],
    [
      'listArtifactVersions',
      (service, key) =>
        service.listArtifactVersions({...key, filename: 'notes.txt'}),
    ],
    [
      'getArtifactVersion',
      (service, key) =>
        service.getArtifactVersion({...key, filename: 'notes.txt'}),
    ],
    ['listArtifactKeys', (service, key) => service.listArtifactKeys(key)],
    [
      'getAuthenticatedUrl',
      (service, key) =>
        service.getAuthenticatedUrl({...key, filename: 'notes.txt'}),
    ],
    [
      'getSignedUrl',
      (service, key) => service.getSignedUrl({...key, filename: 'notes.txt'}),
    ],
  ];

  const FIELDS = ['appName', 'userId', 'sessionId'] as const;

  function keyWith(field: (typeof FIELDS)[number], value: string) {
    const key: CompositeSessionKey = {...SESSION_KEY};
    key[field] = value;
    return key;
  }

  describe.each(OPERATIONS)('%s', (_name, operation) => {
    it.each(FIELDS)('rejects a traversal segment in %s', async (field) => {
      const service = newService();

      await expect(
        operation(service, keyWith(field, '../escape')),
      ).rejects.toThrow(InputValidationError);
    });
  });

  it.each([
    ['/etc/passwd', 'must not be an absolute path or start with a slash'],
    ['C:\\absolute', 'must not be drive-qualified'],
    ['', 'must not be empty'],
    ['null\u0000byte', 'must not contain null bytes'],
  ])('rejects saving under the user id %j', async (value, reason) => {
    const service = newService();

    await expect(
      service.saveArtifact({
        ...keyWith('userId', value),
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      }),
    ).rejects.toThrow(reason);
  });

  it('accepts a namespaced user id', async () => {
    const service = newService();
    const key = keyWith('userId', 'group/user123');

    await service.saveArtifact({
      ...key,
      filename: 'notes.txt',
      artifact: {text: 'v0'},
    });

    const loaded = await service.loadArtifact({...key, filename: 'notes.txt'});
    expect(loaded?.text).toBe('v0');
    expect(
      storageMock
        .bucket(BUCKET)
        .files.has('test-app/group/user123/test-session/notes.txt/0'),
    ).toBe(true);
  });

  it('rejects an empty session id for a session-scoped artifact', async () => {
    const service = newService();

    await expect(
      service.saveArtifact({
        ...keyWith('sessionId', ''),
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      }),
    ).rejects.toThrow('session_id must not be empty.');
  });

  it('ignores the session id for a user-scoped artifact', async () => {
    const service = newService();

    const version = await service.saveArtifact({
      ...keyWith('sessionId', ''),
      filename: 'user:prefs.json',
      artifact: {text: '{}'},
    });

    expect(version).toBe(0);
    expect(
      storageMock
        .bucket(BUCKET)
        .files.has('test-app/test-user/user/prefs.json/0'),
    ).toBe(true);
  });
});
