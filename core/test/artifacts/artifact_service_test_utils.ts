/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseArtifactService, CompositeSessionKey} from '@google/adk';
import {Part} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

/**
 * Runs the shared artifact service tests.
 *
 * @param createService A function that returns a promise that resolves to the artifact service.
 * @param cleanup A function that returns a promise that cleans up the artifact service.
 * @param suiteName The name of the test suite.
 */
export function runArtifactServiceTests(
  createService: () => Promise<BaseArtifactService>,
  cleanup: () => Promise<void>,
) {
  let service: BaseArtifactService;
  const appName = 'test-app';
  const userId = 'test-user';
  const sessionId = 'test-session';

  beforeEach(async () => {
    service = await createService();
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('saveArtifact', () => {
    it('saves a text artifact', async () => {
      const filename = 'test.txt';
      const text = 'hello world';
      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text},
      });

      expect(version).toBe(0);
      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });
      expect(loaded?.text).toBe(text);
    });

    it('saves a binary artifact', async () => {
      const filename = 'test.png';
      const data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgDNjd8qAAAAAElFTkSuQmCC';
      const mimeType = 'image/png';
      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {inlineData: {data, mimeType}},
      });

      expect(version).toBe(0);
      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });
      expect(loaded?.inlineData?.data).toBe(data);
      expect(loaded?.inlineData?.mimeType).toBe(mimeType);
    });

    it('saves user-scoped artifact', async () => {
      const filename = 'user:test.txt';
      const text = 'user scoped';
      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text},
      });

      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version,
      });
      expect(loaded?.text).toBe(text);
    });

    it('throws error if artifact has no content', async () => {
      await expect(
        service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: 'test.txt',
          artifact: {} as unknown as Part,
        }),
      ).rejects.toThrow('Artifact must have either inlineData or text');
    });

    it('increments version number', async () => {
      const filename = 'test.txt';
      const version1 = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'v1'},
      });
      expect(version1).toBe(0);

      const version2 = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'v2'},
      });
      expect(version2).toBe(1);
    });
  });

  describe('loadArtifact', () => {
    it('returns undefined for non-existent artifact', async () => {
      const result = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename: 'nonexistent.txt',
      });
      expect(result).toBeUndefined();
    });

    it('returns undefined for non-existent version', async () => {
      const filename = 'missing-version.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'v0'},
      });

      const result = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 999,
      });
      expect(result).toBeUndefined();
    });

    it('loads specific version', async () => {
      const filename = 'history.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'v0'},
      });
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'v1'},
      });

      const v0 = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });
      expect(v0?.text).toBe('v0');

      const v1 = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
        version: 1,
      });
      expect(v1?.text).toBe('v1');

      const v = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(v?.text).toBe('v1');
    });
  });

  describe('listArtifactKeys', () => {
    it('lists artifacts for session and user', async () => {
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename: 'session.txt',
        artifact: {text: '.'},
      });
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename: 'nested/dir/session.txt',
        artifact: {text: '.'},
      });
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename: 'user:user.txt',
        artifact: {text: '.'},
      });

      const keys = await service.listArtifactKeys({
        appName,
        userId,
        sessionId,
      });
      expect(keys).toContain('session.txt');
      expect(keys).toContain('nested/dir/session.txt');
      expect(keys).toContain('user:user.txt');
    });
  });

  describe('deleteArtifact', () => {
    it('deletes an artifact', async () => {
      const filename = 'del.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '.'},
      });
      await service.deleteArtifact({appName, userId, sessionId, filename});

      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(loaded).toBeUndefined();
    });

    it('does not fail when deleting non-existent artifact', async () => {
      await service.deleteArtifact({
        appName,
        userId,
        sessionId,
        filename: 'non-existent',
      });
    });
  });

  describe('listVersions', () => {
    it('lists versions', async () => {
      const filename = 'vers.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '1'},
      });
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '2'},
      });

      const versions = await service.listVersions({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(versions).toEqual([0, 1]);
    });

    it('returns empty list for non-existent artifact', async () => {
      const versions = await service.listVersions({
        appName,
        userId,
        sessionId,
        filename: 'non-existent',
      });
      expect(versions).toEqual([]);
    });
  });

  describe('customMetadata', () => {
    it('saves and retrieves custom metadata', async () => {
      const filename = 'meta.txt';
      const customMetadata = {foo: 'bar', baz: 123};
      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'meta'},
        customMetadata,
      });

      const versionMetadata = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
        version,
      });

      expect(versionMetadata).toBeDefined();
      expect(versionMetadata?.customMetadata).toMatchObject(customMetadata);
    });
  });

  describe('listArtifactVersions', () => {
    it('lists artifact versions with metadata', async () => {
      const filename = 'vers-meta.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '1'},
        customMetadata: {v: 1},
      });
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '2'},
        customMetadata: {v: 2},
      });

      const versions = await service.listArtifactVersions({
        appName,
        userId,
        sessionId,
        filename,
      });

      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(0);
      expect(versions[0].customMetadata).toMatchObject({v: 1});
      expect(versions[1].version).toBe(1);
      expect(versions[1].customMetadata).toMatchObject({v: 2});
    });

    it('returns empty list for non-existent artifact', async () => {
      const versions = await service.listArtifactVersions({
        appName,
        userId,
        sessionId,
        filename: 'non-existent',
      });
      expect(versions).toHaveLength(0);
    });
  });

  describe('getArtifactVersion', () => {
    it('gets specific artifact version metadata', async () => {
      const filename = 'get-vers.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '1'},
        customMetadata: {v: 1},
      });
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '2'},
        customMetadata: {v: 2},
      });

      const v0 = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
        version: 0,
      });
      expect(v0?.customMetadata).toMatchObject({v: 1});

      const v1 = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
        version: 1,
      });
      expect(v1?.customMetadata).toMatchObject({v: 2});

      const latest = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(latest?.customMetadata).toMatchObject({v: 2});
    });

    it('returns undefined for non-existent version', async () => {
      const filename = 'missing-vers.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: '1'},
      });

      const missing = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
        version: 99,
      });
      expect(missing).toBeUndefined();
    });

    it('returns undefined for non-existent artifact', async () => {
      const missing = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename: 'non-existent',
      });
      expect(missing).toBeUndefined();
    });
  });

  describe('fileData artifacts', () => {
    it('saves and loads an external gs:// URI reference', async () => {
      const filename = 'report.pdf';
      const fileUri = 'gs://my-bucket/report.pdf';
      const mimeType = 'application/pdf';

      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {fileData: {fileUri, mimeType}},
      });
      expect(version).toBe(0);

      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(loaded?.fileData?.fileUri).toBe(fileUri);
      expect(loaded?.fileData?.mimeType).toBe(mimeType);
    });

    it('saves fileData without a mimeType', async () => {
      const filename = 'data.bin';
      const fileUri = 'gs://my-bucket/data.bin';

      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {fileData: {fileUri}},
      });
      expect(version).toBe(0);

      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(loaded?.fileData?.fileUri).toBe(fileUri);
    });

    it('ignores a stray/empty fileData sibling when inlineData is present', async () => {
      const filename = 'both.png';
      const data =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgDNjd8qAAAAAElFTkSuQmCC';
      const mimeType = 'image/png';

      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {inlineData: {data, mimeType}, fileData: {}},
      });
      expect(version).toBe(0);

      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(loaded?.inlineData?.data).toBe(data);
      expect(loaded?.inlineData?.mimeType).toBe(mimeType);
    });

    it('ignores a stray fileData sibling when text is present and does not corrupt mimeType metadata', async () => {
      const filename = 'both.txt';

      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {
          text: 'hello world',
          fileData: {
            fileUri: 'https://example.com/a.png',
            mimeType: 'image/png',
          },
        },
      });

      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(loaded?.text).toBe('hello world');

      const versionMetadata = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
        version,
      });
      expect(versionMetadata?.mimeType).not.toBe('image/png');
    });
  });

  describe('CompositeSessionKey compatibility', () => {
    it('supports pre-constructed CompositeSessionKey for artifact operations', async () => {
      const sessionKey: CompositeSessionKey = {
        appName,
        userId,
        sessionId,
      };
      const filename = 'composite-key-test.txt';
      const text = 'testing composite key';

      const version = await service.saveArtifact({
        ...sessionKey,
        filename,
        artifact: {text},
      });
      expect(version).toBe(0);

      const loaded = await service.loadArtifact({
        ...sessionKey,
        filename,
        version: 0,
      });
      expect(loaded?.text).toBe(text);

      const keys = await service.listArtifactKeys(sessionKey);
      expect(keys).toContain(filename);

      const versions = await service.listVersions({
        ...sessionKey,
        filename,
      });
      expect(versions).toEqual([0]);

      await service.deleteArtifact({
        ...sessionKey,
        filename,
      });
      const keysAfterDelete = await service.listArtifactKeys(sessionKey);
      expect(keysAfterDelete).not.toContain(filename);
    });
  });

  describe('whitespace-padded filenames', () => {
    const PADDED_FILENAMES: Array<[label: string, filename: string]> = [
      ['a leading space', ' padded.txt'],
      ['a trailing space', 'padded.txt '],
      ['leading and trailing spaces', ' padded.txt '],
      ['a trailing tab', 'padded.txt\t'],
      ['only whitespace', '   '],
      ['padding after the user: prefix', 'user: padded.txt'],
    ];

    it.each(PADDED_FILENAMES)(
      'rejects saving a filename with %s',
      async (_label, filename) => {
        await expect(
          service.saveArtifact({
            appName,
            userId,
            sessionId,
            filename,
            artifact: {text: 'rejected'},
          }),
        ).rejects.toThrow(/leading or trailing whitespace/);
      },
    );

    it('does not resolve a padded filename onto the unpadded artifact', async () => {
      const filename = 'padded.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'unpadded'},
      });

      expect(
        await service.loadArtifact({
          appName,
          userId,
          sessionId,
          filename: ' padded.txt',
        }),
      ).toBeUndefined();
      expect(
        await service.loadArtifact({
          appName,
          userId,
          sessionId,
          filename: 'padded.txt ',
        }),
      ).toBeUndefined();
      expect(
        await service.getArtifactVersion({
          appName,
          userId,
          sessionId,
          filename: ' padded.txt',
        }),
      ).toBeUndefined();
      expect(
        await service.listVersions({
          appName,
          userId,
          sessionId,
          filename: 'padded.txt ',
        }),
      ).toEqual([]);
      expect(
        await service.listArtifactVersions({
          appName,
          userId,
          sessionId,
          filename: ' padded.txt',
        }),
      ).toEqual([]);
    });

    it('deletes nothing when the padded filename is deleted', async () => {
      const filename = 'padded.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'unpadded'},
      });

      await service.deleteArtifact({
        appName,
        userId,
        sessionId,
        filename: 'padded.txt ',
      });

      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename,
      });
      expect(loaded?.text).toBe('unpadded');
      const keys = await service.listArtifactKeys({
        appName,
        userId,
        sessionId,
      });
      expect(keys).toContain(filename);
    });

    it('stores nothing when a padded save is rejected', async () => {
      await expect(
        service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: ' fresh.txt',
          artifact: {text: 'rejected'},
        }),
      ).rejects.toThrow(/leading or trailing whitespace/);

      const keys = await service.listArtifactKeys({
        appName,
        userId,
        sessionId,
      });
      expect(keys).not.toContain(' fresh.txt');
      expect(keys).not.toContain('fresh.txt');
      expect(
        await service.listVersions({
          appName,
          userId,
          sessionId,
          filename: 'fresh.txt',
        }),
      ).toEqual([]);
    });

    it('does not version a padded filename onto the unpadded artifact', async () => {
      const filename = 'a.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'first'},
      });

      await expect(
        service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: ' a.txt',
          artifact: {text: 'second'},
        }),
      ).rejects.toThrow(/leading or trailing whitespace/);

      expect(
        await service.listVersions({appName, userId, sessionId, filename}),
      ).toEqual([0]);
      expect(
        (await service.loadArtifact({appName, userId, sessionId, filename}))
          ?.text,
      ).toBe('first');
    });
  });

  describe('trailing-period filenames', () => {
    const TRAILING_PERIOD_FILENAMES: Array<[label: string, filename: string]> =
      [
        ['a trailing period', 'trailing.dot.'],
        ['repeated trailing periods', 'trailing.dot..'],
        ['a trailing period on an interior segment', 'nested./report.txt'],
        ['a trailing period after the user: prefix', 'user:trailing.dot.'],
      ];

    it.each(TRAILING_PERIOD_FILENAMES)(
      'rejects saving a filename with %s',
      async (_label, filename) => {
        await expect(
          service.saveArtifact({
            appName,
            userId,
            sessionId,
            filename,
            artifact: {text: 'rejected'},
          }),
        ).rejects.toThrow(/ending in a period/);
      },
    );

    it('does not fold a trailing-period filename onto its bare twin', async () => {
      const filename = 'trailing.dot';
      expect(
        await service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename,
          artifact: {text: 'bare'},
        }),
      ).toBe(0);

      await expect(
        service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: 'trailing.dot.',
          artifact: {text: 'dotted'},
        }),
      ).rejects.toThrow(/ending in a period/);

      expect(
        await service.listVersions({appName, userId, sessionId, filename}),
      ).toEqual([0]);
      expect(
        (await service.loadArtifact({appName, userId, sessionId, filename}))
          ?.text,
      ).toBe('bare');
      expect(
        await service.loadArtifact({
          appName,
          userId,
          sessionId,
          filename: 'trailing.dot.',
        }),
      ).toBeUndefined();

      const keys = await service.listArtifactKeys({
        appName,
        userId,
        sessionId,
      });
      expect(keys).toContain(filename);
      expect(keys).not.toContain('trailing.dot.');
    });

    it('stores nothing when a trailing-period save is rejected', async () => {
      await expect(
        service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: 'fresh.',
          artifact: {text: 'rejected'},
        }),
      ).rejects.toThrow(/ending in a period/);

      const keys = await service.listArtifactKeys({
        appName,
        userId,
        sessionId,
      });
      expect(keys).not.toContain('fresh.');
      expect(keys).not.toContain('fresh');
      expect(
        await service.listVersions({
          appName,
          userId,
          sessionId,
          filename: 'fresh',
        }),
      ).toEqual([]);
    });

    it('deletes nothing when the trailing-period twin is deleted', async () => {
      const filename = 'keep.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'kept'},
      });

      await service.deleteArtifact({
        appName,
        userId,
        sessionId,
        filename: 'keep.txt.',
      });

      expect(
        (await service.loadArtifact({appName, userId, sessionId, filename}))
          ?.text,
      ).toBe('kept');
      expect(
        await service.listArtifactKeys({appName, userId, sessionId}),
      ).toContain(filename);
    });

    it('does not resolve a trailing-period filename onto the bare artifact', async () => {
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename: 'probe.txt',
        artifact: {text: 'bare'},
      });

      const filename = 'probe.txt.';
      expect(
        await service.loadArtifact({appName, userId, sessionId, filename}),
      ).toBeUndefined();
      expect(
        await service.getArtifactVersion({
          appName,
          userId,
          sessionId,
          filename,
        }),
      ).toBeUndefined();
      expect(
        await service.listVersions({appName, userId, sessionId, filename}),
      ).toEqual([]);
      expect(
        await service.listArtifactVersions({
          appName,
          userId,
          sessionId,
          filename,
        }),
      ).toEqual([]);
    });
  });

  describe('Windows-reserved filenames', () => {
    const RESERVED_FILENAMES: Array<[label: string, filename: string]> = [
      ['a lowercase device name', 'nul.txt'],
      ['a bare device name', 'NUL'],
      ['a COM port device name', 'com1.log'],
      ['a device name in an interior segment', 'nested/nul/report.txt'],
      ['a device name after the user: prefix', 'user:nul.txt'],
      ['a colon', 'a:b.txt'],
      ['a question mark', 'a?b.txt'],
      ['angle brackets', 'report<1>.txt'],
      ['a pipe', 'a|b.txt'],
    ];

    const ACCEPTED_NEAR_MISSES: Array<[label: string, filename: string]> = [
      ['a device name as a prefix of the stem', 'null.txt'],
      ['the unreserved COM0', 'com0.txt'],
      ['a word starting with CON', 'connections.txt'],
      ['a device name in the extension', 'a.nul'],
      ['an interior space', 'my report.txt'],
    ];

    it.each(RESERVED_FILENAMES)(
      'rejects saving a filename with %s',
      async (_label, filename) => {
        await expect(
          service.saveArtifact({
            appName,
            userId,
            sessionId,
            filename,
            artifact: {text: 'rejected'},
          }),
        ).rejects.toThrow(/reserved/);
      },
    );

    it('stores nothing when a reserved save is rejected', async () => {
      const filename = 'nul.txt';
      await expect(
        service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename,
          artifact: {text: 'rejected'},
        }),
      ).rejects.toThrow(/reserved/);

      const keys = await service.listArtifactKeys({
        appName,
        userId,
        sessionId,
      });
      expect(keys).not.toContain(filename);
      expect(keys).not.toContain('nul');
      expect(keys).not.toContain('NUL');
      expect(
        await service.listVersions({appName, userId, sessionId, filename}),
      ).toEqual([]);
    });

    it.each([
      ['a device name', 'nul.txt'],
      ['a reserved character', 'a:b.txt'],
    ])('reads nothing back for a filename with %s', async (_l, filename) => {
      expect(
        await service.loadArtifact({appName, userId, sessionId, filename}),
      ).toBeUndefined();
      expect(
        await service.getArtifactVersion({
          appName,
          userId,
          sessionId,
          filename,
        }),
      ).toBeUndefined();
      expect(
        await service.listVersions({appName, userId, sessionId, filename}),
      ).toEqual([]);
      expect(
        await service.listArtifactVersions({
          appName,
          userId,
          sessionId,
          filename,
        }),
      ).toEqual([]);
    });

    it('deletes nothing when a reserved filename is deleted', async () => {
      const filename = 'report.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'kept'},
      });

      await service.deleteArtifact({
        appName,
        userId,
        sessionId,
        filename: 'nul.txt',
      });

      expect(
        (await service.loadArtifact({appName, userId, sessionId, filename}))
          ?.text,
      ).toBe('kept');
      expect(
        await service.listArtifactKeys({appName, userId, sessionId}),
      ).toContain(filename);
    });

    it('leaves an existing artifact untouched by a rejected save', async () => {
      const filename = 'a.txt';
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'first'},
      });

      await expect(
        service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: 'a:b.txt',
          artifact: {text: 'rejected'},
        }),
      ).rejects.toThrow(/reserved/);
      await expect(
        service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: 'nul.txt',
          artifact: {text: 'rejected'},
        }),
      ).rejects.toThrow(/reserved/);

      expect(
        await service.listVersions({appName, userId, sessionId, filename}),
      ).toEqual([0]);
      expect(
        (await service.loadArtifact({appName, userId, sessionId, filename}))
          ?.text,
      ).toBe('first');
    });

    it.each(ACCEPTED_NEAR_MISSES)(
      'stores a filename with %s',
      async (_label, filename) => {
        const text = `content of ${filename}`;
        expect(
          await service.saveArtifact({
            appName,
            userId,
            sessionId,
            filename,
            artifact: {text},
          }),
        ).toBe(0);

        expect(
          (await service.loadArtifact({appName, userId, sessionId, filename}))
            ?.text,
        ).toBe(text);
        expect(
          await service.listArtifactKeys({appName, userId, sessionId}),
        ).toContain(filename);
      },
    );
  });
}
