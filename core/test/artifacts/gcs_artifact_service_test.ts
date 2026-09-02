/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GcsArtifactService, InputValidationError} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';

const {StorageMock, storageMock, TIME_CREATED} = vi.hoisted(() => {
  /** The creation time the fake stamps on every object it writes. */
  const TIME_CREATED = '2026-01-01T00:00:00.000Z';

  /** The shape the storage client rejects with for a missing object. */
  class FakeNotFoundError extends Error {
    code = 404;
  }

  interface FakeSignedUrlConfig {
    action: string;
    expires: string | number | Date;
    version?: 'v2' | 'v4';
    virtualHostedStyle?: boolean;
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
        throw new FakeNotFoundError(`File not found: ${this.name}`);
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
      if (this.bucket.metadataFailure) {
        throw this.bucket.metadataFailure;
      }
      const file = this.bucket.files.get(this.name);
      if (!file) {
        throw new FakeNotFoundError(`File not found: ${this.name}`);
      }
      // GCS omits `metadata` entirely when an object carries none.
      const hasCustomMetadata = Object.keys(file.metadata).length > 0;
      return [
        {
          contentType: file.contentType,
          metadata: hasCustomMetadata ? file.metadata : undefined,
          timeCreated: file.timeCreated,
        },
      ];
    }

    async getSignedUrl(config: FakeSignedUrlConfig): Promise<[string]> {
      this.bucket.storage.signedUrlConfigs.push(config);
      return [
        `https://storage.example.com/${this.bucket.name}/${this.name}` +
          `?signed=true&action=${config.action}&expires=${String(config.expires)}` +
          (config.version ? `&version=${config.version}` : ''),
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

    /** When set, every listing rejects, standing in for a storage failure. */
    listFailure?: Error;
    /** When set, every metadata read rejects with this error. */
    metadataFailure?: Error;

    constructor(
      public name: string,
      public storage: FakeStorage,
    ) {}

    file(name: string): FakeGcsFile {
      return new FakeGcsFile(name, this);
    }

    async getFiles(options?: {prefix?: string}): Promise<[FakeGcsFile[]]> {
      if (this.listFailure) {
        throw this.listFailure;
      }
      let files = Array.from(this.files.keys()).map((name) => this.file(name));
      if (options?.prefix) {
        files = files.filter((f) => f.name.startsWith(options.prefix!));
      }
      return [files];
    }
  }

  class FakeStorage {
    buckets = new Map<string, FakeGcsBucket>();
    /** Every signing config the service has forwarded, oldest first. */
    signedUrlConfigs: FakeSignedUrlConfig[] = [];

    bucket(name: string): FakeGcsBucket {
      if (!this.buckets.has(name)) {
        this.buckets.set(name, new FakeGcsBucket(name, this));
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

  const scope = {appName: 'app', userId: 'user1', sessionId: 'sess1'};

  /** Unix seconds matching the fake's fixed creation time. */
  const CREATE_TIME_SECONDS = 1767225600;

  interface RefOverrides {
    appName?: string;
    userId?: string;
    sessionId?: string;
    version?: number;
  }

  function createService(): GcsArtifactService {
    storageMock.buckets.clear();
    storageMock.signedUrlConfigs.length = 0;
    return new GcsArtifactService(bucketName);
  }

  /** Builds a session-scoped artifact reference URI. */
  function sessionRef(filename: string, overrides: RefOverrides = {}): string {
    const {
      appName = scope.appName,
      userId = scope.userId,
      sessionId = scope.sessionId,
      version = 0,
    } = overrides;
    return `artifact://apps/${appName}/users/${userId}/sessions/${sessionId}/artifacts/${filename}/versions/${version}`;
  }

  /** Builds a user-scoped artifact reference URI, which names no session. */
  function userRef(filename: string, version = 0): string {
    return `artifact://apps/${scope.appName}/users/${scope.userId}/artifacts/${filename}/versions/${version}`;
  }

  /** Saves `length` references, so that ref1 leads through them to leaf.txt. */
  async function saveReferenceChain(
    service: GcsArtifactService,
    length: number,
  ): Promise<void> {
    await service.saveArtifact({
      ...scope,
      filename: 'leaf.txt',
      artifact: {text: 'leaf content'},
    });
    for (let i = length; i >= 1; i--) {
      await service.saveArtifact({
        ...scope,
        filename: `ref${i}.txt`,
        artifact: {
          fileData: {
            fileUri: sessionRef(i === length ? 'leaf.txt' : `ref${i + 1}.txt`),
            mimeType: 'text/plain',
          },
        },
      });
    }
  }

  describe('getAuthenticatedUrl', () => {
    it('addresses the latest version when the request omits one', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      });
      await service.saveArtifact({
        ...scope,
        filename: 'notes.txt',
        artifact: {text: 'v1'},
      });

      await expect(
        service.getAuthenticatedUrl({...scope, filename: 'notes.txt'}),
      ).resolves.toBe(
        'https://storage.cloud.google.com/test-bucket/app/user1/sess1/notes.txt/1',
      );
    });

    it('addresses the version the request names', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      });
      await service.saveArtifact({
        ...scope,
        filename: 'notes.txt',
        artifact: {text: 'v1'},
      });

      await expect(
        service.getAuthenticatedUrl({
          ...scope,
          filename: 'notes.txt',
          version: 0,
        }),
      ).resolves.toBe(
        'https://storage.cloud.google.com/test-bucket/app/user1/sess1/notes.txt/0',
      );
    });

    it('returns undefined for an artifact that does not exist', async () => {
      const service = createService();

      await expect(
        service.getAuthenticatedUrl({...scope, filename: 'missing.txt'}),
      ).resolves.toBeUndefined();
    });

    it('returns undefined for a version that does not exist', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      });

      await expect(
        service.getAuthenticatedUrl({
          ...scope,
          filename: 'notes.txt',
          version: 5,
        }),
      ).resolves.toBeUndefined();
    });

    it('percent-encodes every path segment', async () => {
      const service = createService();
      const filename = 'notes#1?v=100%real name.txt';
      await service.saveArtifact({...scope, filename, artifact: {text: 'v0'}});

      await expect(
        service.getAuthenticatedUrl({...scope, filename}),
      ).resolves.toBe(
        'https://storage.cloud.google.com/test-bucket/app/user1/sess1/notes%231%3Fv%3D100%25real%20name.txt/0',
      );
    });

    it('addresses a user-scoped artifact without a session', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'user:profile.png',
        artifact: {text: 'v0'},
      });

      await expect(
        service.getAuthenticatedUrl({
          appName: scope.appName,
          userId: scope.userId,
          filename: 'user:profile.png',
        }),
      ).resolves.toBe(
        'https://storage.cloud.google.com/test-bucket/app/user1/user/profile.png/0',
      );
    });

    it('resolves a reference to the target artifact URL', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'source.txt',
        artifact: {text: 'hello'},
      });
      await service.saveArtifact({
        ...scope,
        filename: 'ref.txt',
        artifact: {
          fileData: {fileUri: sessionRef('source.txt'), mimeType: 'text/plain'},
        },
      });

      await expect(
        service.getAuthenticatedUrl({...scope, filename: 'ref.txt'}),
      ).resolves.toBe(
        'https://storage.cloud.google.com/test-bucket/app/user1/sess1/source.txt/0',
      );
    });

    it('returns undefined for a pointer to an external URI', async () => {
      const service = createService();
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

      await expect(
        service.getAuthenticatedUrl({...scope, filename: 'external.txt'}),
      ).resolves.toBeUndefined();
    });

    it('rejects a session-scoped artifact addressed without a session', async () => {
      const service = createService();

      await expect(
        service.getAuthenticatedUrl({
          appName: scope.appName,
          userId: scope.userId,
          filename: 'notes.txt',
        }),
      ).rejects.toThrow(
        'Session ID must be provided for session-scoped artifacts.',
      );
    });
  });

  describe('getSignedUrl', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('defaults to a read action expiring one hour out', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      });

      await service.getSignedUrl({...scope, filename: 'notes.txt'});

      expect(storageMock.signedUrlConfigs).toEqual([
        {action: 'read', expires: Date.parse('2026-01-01T01:00:00.000Z')},
      ]);
    });

    it('returns the URL the storage client mints', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      });

      await expect(
        service.getSignedUrl({
          ...scope,
          filename: 'notes.txt',
          signingOptions: {expires: 1767229200000, version: 'v4'},
        }),
      ).resolves.toBe(
        'https://storage.example.com/test-bucket/app/user1/sess1/notes.txt/0' +
          '?signed=true&action=read&expires=1767229200000&version=v4',
      );
    });

    it('lets the caller override the default action and expiry', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      });

      await service.getSignedUrl({
        ...scope,
        filename: 'notes.txt',
        signingOptions: {action: 'write', expires: 1767229200000},
      });

      expect(storageMock.signedUrlConfigs).toEqual([
        {action: 'write', expires: 1767229200000},
      ]);
    });

    it('forwards an option it does not itself use', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      });

      await service.getSignedUrl({
        ...scope,
        filename: 'notes.txt',
        signingOptions: {virtualHostedStyle: true},
      });

      expect(storageMock.signedUrlConfigs[0].virtualHostedStyle).toBe(true);
    });

    it('returns undefined for an artifact that does not exist', async () => {
      const service = createService();

      await expect(
        service.getSignedUrl({...scope, filename: 'missing.txt'}),
      ).resolves.toBeUndefined();
      expect(storageMock.signedUrlConfigs).toEqual([]);
    });

    it('resolves a reference to the target artifact URL', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'source.txt',
        artifact: {text: 'hello'},
      });
      await service.saveArtifact({
        ...scope,
        filename: 'ref.txt',
        artifact: {
          fileData: {fileUri: sessionRef('source.txt'), mimeType: 'text/plain'},
        },
      });

      await expect(
        service.getSignedUrl({
          ...scope,
          filename: 'ref.txt',
          signingOptions: {expires: 1767229200000},
        }),
      ).resolves.toBe(
        'https://storage.example.com/test-bucket/app/user1/sess1/source.txt/0' +
          '?signed=true&action=read&expires=1767229200000',
      );
    });

    it('returns undefined for a pointer to an external URI', async () => {
      const service = createService();
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

      await expect(
        service.getSignedUrl({...scope, filename: 'external.txt'}),
      ).resolves.toBeUndefined();
    });

    it('addresses a user-scoped artifact without a session', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'user:profile.png',
        artifact: {text: 'v0'},
      });

      await expect(
        service.getSignedUrl({
          appName: scope.appName,
          userId: scope.userId,
          filename: 'user:profile.png',
          signingOptions: {expires: 1767229200000},
        }),
      ).resolves.toBe(
        'https://storage.example.com/test-bucket/app/user1/user/profile.png/0' +
          '?signed=true&action=read&expires=1767229200000',
      );
    });
  });

  describe('artifact references', () => {
    it('loads the target content through a reference', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'source.txt',
        artifact: {text: 'target content'},
      });
      await service.saveArtifact({
        ...scope,
        filename: 'ref.txt',
        artifact: {
          fileData: {fileUri: sessionRef('source.txt'), mimeType: 'text/plain'},
        },
      });

      const loaded = await service.loadArtifact({
        ...scope,
        filename: 'ref.txt',
      });

      expect(loaded?.text).toBe('target content');
    });

    it('follows a user-scoped reference from another session', async () => {
      const service = createService();
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
            fileUri: userRef('user:profile.txt'),
            mimeType: 'text/plain',
          },
        },
      });

      const loaded = await service.loadArtifact({
        ...scope,
        sessionId: 'sess2',
        filename: 'ref.txt',
      });

      expect(loaded?.text).toBe('profile');
    });

    it('rejects saving a reference to another user', async () => {
      const service = createService();

      await expect(
        service.saveArtifact({
          ...scope,
          filename: 'ref.txt',
          artifact: {
            fileData: {
              fileUri: sessionRef('source.txt', {userId: 'victim'}),
              mimeType: 'text/plain',
            },
          },
        }),
      ).rejects.toThrow('same app and user scope');
    });

    it('rejects saving a reference to another app', async () => {
      const service = createService();

      await expect(
        service.saveArtifact({
          ...scope,
          filename: 'ref.txt',
          artifact: {
            fileData: {
              fileUri: sessionRef('source.txt', {appName: 'victim-app'}),
              mimeType: 'text/plain',
            },
          },
        }),
      ).rejects.toThrow('same app and user scope');
    });

    it('rejects saving a reference to another session', async () => {
      const service = createService();

      await expect(
        service.saveArtifact({
          ...scope,
          filename: 'ref.txt',
          artifact: {
            fileData: {
              fileUri: sessionRef('source.txt', {sessionId: 'sess2'}),
              mimeType: 'text/plain',
            },
          },
        }),
      ).rejects.toThrow('same session scope');
    });

    it('rejects saving a reference URI that does not parse', async () => {
      const service = createService();

      await expect(
        service.saveArtifact({
          ...scope,
          filename: 'ref.txt',
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

    it('rejects loading a stored reference retargeted at another session', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'source.txt',
        artifact: {text: 'same session'},
      });
      await service.saveArtifact({
        ...scope,
        filename: 'ref.txt',
        artifact: {
          fileData: {fileUri: sessionRef('source.txt'), mimeType: 'text/plain'},
        },
      });

      const stored = storageMock
        .bucket(bucketName)
        .files.get('app/user1/sess1/ref.txt/0');
      if (!stored) {
        expect.fail('the reference artifact was not stored');
      }
      stored.metadata['adkFileUri'] = sessionRef('source.txt', {
        sessionId: 'sess2',
      });

      await expect(
        service.loadArtifact({...scope, filename: 'ref.txt'}),
      ).rejects.toThrow('same session scope');
    });

    it('resolves a chain of five references', async () => {
      const service = createService();
      await saveReferenceChain(service, 5);

      const loaded = await service.loadArtifact({
        ...scope,
        filename: 'ref1.txt',
      });

      expect(loaded?.text).toBe('leaf content');
    });

    it('rejects a chain of six references', async () => {
      const service = createService();
      await saveReferenceChain(service, 6);

      await expect(
        service.loadArtifact({...scope, filename: 'ref1.txt'}),
      ).rejects.toThrow('Exceeded maximum recursion depth');
    });

    it.each([
      [
        'loadArtifact',
        (service: GcsArtifactService) =>
          service.loadArtifact({...scope, filename: 'loop.txt'}),
      ],
      [
        'getAuthenticatedUrl',
        (service: GcsArtifactService) =>
          service.getAuthenticatedUrl({...scope, filename: 'loop.txt'}),
      ],
      [
        'getSignedUrl',
        (service: GcsArtifactService) =>
          service.getSignedUrl({...scope, filename: 'loop.txt'}),
      ],
    ])('%s rejects an artifact that references itself', async (_name, call) => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'loop.txt',
        artifact: {
          fileData: {fileUri: sessionRef('loop.txt'), mimeType: 'text/plain'},
        },
      });

      await expect(call(service)).rejects.toThrow(
        'Exceeded maximum recursion depth resolving artifact reference',
      );
    });
  });

  describe('path segment validation', () => {
    describe.each<
      [
        string,
        (
          service: GcsArtifactService,
          key: {appName: string; userId: string; sessionId: string},
        ) => Promise<unknown>,
      ]
    >([
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
        (service, key) =>
          service.deleteArtifact({...key, filename: 'notes.txt'}),
      ],
      [
        'listVersions',
        (service, key) => service.listVersions({...key, filename: 'notes.txt'}),
      ],
      ['listArtifactKeys', (service, key) => service.listArtifactKeys(key)],
    ])('%s', (_name, call) => {
      it.each(['appName', 'userId', 'sessionId'] as const)(
        'rejects a traversal segment in %s',
        async (field) => {
          const service = createService();

          await expect(
            call(service, {...scope, [field]: '../escape'}),
          ).rejects.toThrow(InputValidationError);
        },
      );
    });
  });

  describe('ArtifactVersion fields', () => {
    const key = {
      appName: 'test-app',
      userId: 'test-user',
      sessionId: 'test-session',
    };

    it('reports a gs:// canonical URI and a creation time in seconds', async () => {
      const service = createService();
      await service.saveArtifact({
        ...key,
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      });

      const artifactVersion = await service.getArtifactVersion({
        ...key,
        filename: 'notes.txt',
        version: 0,
      });

      expect(artifactVersion?.canonicalUri).toBe(
        'gs://test-bucket/test-app/test-user/test-session/notes.txt/0',
      );
      expect(artifactVersion?.createTime).toBe(CREATE_TIME_SECONDS);
      expect(Date.parse(TIME_CREATED) / 1000).toBe(CREATE_TIME_SECONDS);
    });

    it.each([undefined, 'not a timestamp'])(
      'omits createTime when the object reports %s',
      async (timeCreated) => {
        const service = createService();
        storageMock
          .bucket(bucketName)
          .files.set('test-app/test-user/test-session/notes.txt/0', {
            data: Buffer.from('v0'),
            metadata: {},
            contentType: 'text/plain',
            timeCreated,
          });

        const artifactVersion = await service.getArtifactVersion({
          ...key,
          filename: 'notes.txt',
          version: 0,
        });

        expect(artifactVersion?.createTime).toBeUndefined();
      },
    );

    it('lists one record per version, ascending', async () => {
      const service = createService();
      await service.saveArtifact({
        ...key,
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      });
      await service.saveArtifact({
        ...key,
        filename: 'notes.txt',
        artifact: {text: 'v1'},
      });

      const versions = await service.listArtifactVersions({
        ...key,
        filename: 'notes.txt',
      });

      expect(versions.map((version) => version.version)).toEqual([0, 1]);
      expect(versions.map((version) => version.canonicalUri)).toEqual([
        'gs://test-bucket/test-app/test-user/test-session/notes.txt/0',
        'gs://test-bucket/test-app/test-user/test-session/notes.txt/1',
      ]);
      expect(versions.map((version) => version.createTime)).toEqual([
        CREATE_TIME_SECONDS,
        CREATE_TIME_SECONDS,
      ]);
    });
  });

  describe('nested artifacts', () => {
    async function seedNestedArtifacts(
      service: GcsArtifactService,
    ): Promise<void> {
      for (let version = 0; version < 2; version++) {
        await service.saveArtifact({
          ...scope,
          filename: 'doc',
          artifact: {text: `doc-v${version}`},
        });
      }
      for (let version = 0; version < 4; version++) {
        await service.saveArtifact({
          ...scope,
          filename: 'doc/nested',
          artifact: {text: `nested-v${version}`},
        });
      }
    }

    it('keeps a nested artifact out of its parent versions', async () => {
      const service = createService();
      await seedNestedArtifacts(service);

      await expect(
        service.listVersions({...scope, filename: 'doc'}),
      ).resolves.toEqual([0, 1]);
      await expect(
        service.listVersions({...scope, filename: 'doc/nested'}),
      ).resolves.toEqual([0, 1, 2, 3]);
    });

    it('addresses only the parent in its version records', async () => {
      const service = createService();
      await seedNestedArtifacts(service);

      const versions = await service.listArtifactVersions({
        ...scope,
        filename: 'doc',
      });

      expect(versions.map((version) => version.canonicalUri)).toEqual([
        'gs://test-bucket/app/user1/sess1/doc/0',
        'gs://test-bucket/app/user1/sess1/doc/1',
      ]);
    });

    it('leaves a nested artifact in place when the parent is deleted', async () => {
      const service = createService();
      await seedNestedArtifacts(service);

      await service.deleteArtifact({...scope, filename: 'doc'});

      await expect(
        service.listVersions({...scope, filename: 'doc'}),
      ).resolves.toEqual([]);
      await expect(
        service.listVersions({...scope, filename: 'doc/nested'}),
      ).resolves.toEqual([0, 1, 2, 3]);
    });

    it('skips an object whose leaf is not a version number', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      });
      storageMock
        .bucket(bucketName)
        .files.set('app/user1/sess1/notes.txt/3abc', {
          data: Buffer.from('junk'),
          metadata: {},
          contentType: 'text/plain',
        });

      await expect(
        service.listVersions({...scope, filename: 'notes.txt'}),
      ).resolves.toEqual([0]);
    });
  });

  describe('storage failures and sparse metadata', () => {
    it('rejects a fileData artifact that carries no fileUri', async () => {
      const service = createService();

      await expect(
        service.saveArtifact({
          ...scope,
          filename: 'pointer.txt',
          artifact: {fileData: {mimeType: 'text/plain'}},
        }),
      ).rejects.toThrow(InputValidationError);
      await expect(
        service.saveArtifact({
          ...scope,
          filename: 'pointer.txt',
          artifact: {fileData: {mimeType: 'text/plain'}},
        }),
      ).rejects.toThrow('Artifact fileData must have a fileUri.');
    });

    it('rejects a traversal segment in getArtifactVersion', async () => {
      const service = createService();

      await expect(
        service.getArtifactVersion({
          ...scope,
          appName: '../escape',
          filename: 'notes.txt',
        }),
      ).rejects.toThrow(InputValidationError);
    });

    it('reports no artifact when the listing fails', async () => {
      const service = createService();
      storageMock.bucket(bucketName).listFailure = new Error('list failed');

      await expect(
        service.loadArtifact({...scope, filename: 'notes.txt'}),
      ).resolves.toBeUndefined();
      await expect(
        service.getArtifactVersion({...scope, filename: 'notes.txt'}),
      ).resolves.toBeUndefined();
    });

    it('loads an object that carries no custom metadata', async () => {
      const service = createService();
      storageMock.bucket(bucketName).files.set('app/user1/sess1/plain.txt/0', {
        data: Buffer.from('bare content'),
        metadata: {},
        contentType: 'text/plain',
      });

      const loaded = await service.loadArtifact({
        ...scope,
        filename: 'plain.txt',
      });

      expect(loaded?.text).toBe('bare content');
    });

    it.each([
      [
        'a permission failure',
        Object.assign(new Error('forbidden'), {code: 403}),
      ],
      ['an error with no status', new Error('socket hang up')],
    ])('propagates %s from the URL methods', async (_name, failure) => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      });
      storageMock.bucket(bucketName).metadataFailure = failure;

      await expect(
        service.getAuthenticatedUrl({...scope, filename: 'notes.txt'}),
      ).rejects.toThrow(failure.message);
      await expect(
        service.getSignedUrl({...scope, filename: 'notes.txt'}),
      ).rejects.toThrow(failure.message);
    });

    it('reports no artifact when a metadata read fails inside loadArtifact', async () => {
      const service = createService();
      await service.saveArtifact({
        ...scope,
        filename: 'notes.txt',
        artifact: {text: 'v0'},
      });
      storageMock.bucket(bucketName).metadataFailure = Object.assign(
        new Error('forbidden'),
        {code: 403},
      );

      await expect(
        service.loadArtifact({...scope, filename: 'notes.txt'}),
      ).resolves.toBeUndefined();
      await expect(
        service.getArtifactVersion({...scope, filename: 'notes.txt'}),
      ).resolves.toBeUndefined();
    });

    it('honours the legacy file_uri metadata key on load', async () => {
      const service = createService();
      storageMock.bucket(bucketName).files.set('app/user1/sess1/old.pdf/0', {
        data: Buffer.alloc(0),
        metadata: {file_uri: 'gs://legacy-bucket/old.pdf'},
        contentType: 'application/pdf',
      });

      const loaded = await service.loadArtifact({
        ...scope,
        filename: 'old.pdf',
      });

      expect(loaded?.fileData?.fileUri).toBe('gs://legacy-bucket/old.pdf');
    });
  });
});
