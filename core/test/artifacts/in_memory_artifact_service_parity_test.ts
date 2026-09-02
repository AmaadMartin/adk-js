/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryArtifactService, InputValidationError} from '@google/adk';
import {Part} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

const APP_NAME = 'app0';
const USER_ID = 'user0';
const SESSION_ID = '123';

/** Values that must be rejected wherever they build a storage key. */
const INVALID_SEGMENTS: Array<[string, string]> = [
  ['../escape', 'must not contain traversal segments'],
  ['/etc/passwd', 'must not be an absolute path'],
  ['', 'must not be empty'],
];

function sessionUri(filename: string, version = 0, sessionId = SESSION_ID) {
  return `artifact://apps/${APP_NAME}/users/${USER_ID}/sessions/${sessionId}/artifacts/${filename}/versions/${version}`;
}

function userUri(filename: string, version = 0) {
  return `artifact://apps/${APP_NAME}/users/${USER_ID}/artifacts/${filename}/versions/${version}`;
}

describe('InMemoryArtifactService adk-python parity', () => {
  let service: InMemoryArtifactService;

  beforeEach(() => {
    service = new InMemoryArtifactService();
  });

  describe('canonicalUri', () => {
    it('records a session-scoped URI for every version', async () => {
      for (let i = 0; i < 4; i++) {
        await service.saveArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'filename',
          artifact: {text: `content${i}`},
          customMetadata: {key: `value${i}`},
        });
      }

      const versions = await service.listArtifactVersions({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'filename',
      });

      expect(versions).toEqual(
        [0, 1, 2, 3].map((version) => ({
          version,
          canonicalUri: `memory://apps/app0/users/user0/sessions/123/artifacts/filename/versions/${version}`,
          customMetadata: {key: `value${version}`},
          mimeType: 'text/plain',
        })),
      );
    });

    it('returns the latest version by default and a named version on request', async () => {
      for (let i = 0; i < 4; i++) {
        await service.saveArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'filename',
          artifact: {text: `content${i}`},
        });
      }

      const latest = await service.getArtifactVersion({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'filename',
      });
      const third = await service.getArtifactVersion({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'filename',
        version: 2,
      });

      expect(latest?.version).toBe(3);
      expect(latest?.canonicalUri).toBe(
        'memory://apps/app0/users/user0/sessions/123/artifacts/filename/versions/3',
      );
      expect(third?.canonicalUri).toBe(
        'memory://apps/app0/users/user0/sessions/123/artifacts/filename/versions/2',
      );
    });

    it('omits the session segment for a user-namespaced artifact', async () => {
      for (let i = 0; i < 2; i++) {
        await service.saveArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'user:document.pdf',
          artifact: {text: `content${i}`},
        });
      }

      const versions = await service.listArtifactVersions({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'user:document.pdf',
      });

      expect(versions.map((v) => v.canonicalUri)).toEqual([
        'memory://apps/app0/users/user0/artifacts/user:document.pdf/versions/0',
        'memory://apps/app0/users/user0/artifacts/user:document.pdf/versions/1',
      ]);
    });

    it('reports no version metadata for a version that does not exist', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'filename',
        artifact: {text: 'content'},
      });

      await expect(
        service.getArtifactVersion({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'filename',
          version: 99,
        }),
      ).resolves.toBeUndefined();
      await expect(
        service.getArtifactVersion({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'missing',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('artifact reference resolution', () => {
    it('loads the target of a reference to a nested filename', async () => {
      const target: Part = {text: 'target'};
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'folder/file456',
        artifact: target,
      });
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'reference',
        artifact: {
          fileData: {
            fileUri: sessionUri('folder/file456'),
            mimeType: 'text/plain',
          },
        },
      });

      await expect(
        service.loadArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'reference',
        }),
      ).resolves.toEqual(target);
    });

    it('allows a reference inside the same session', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'source.txt',
        artifact: {text: 'hello'},
      });
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'ref.txt',
        artifact: {
          fileData: {fileUri: sessionUri('source.txt'), mimeType: 'text/plain'},
        },
      });

      await expect(
        service.loadArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'ref.txt',
        }),
      ).resolves.toEqual({text: 'hello'});
    });

    it('allows a user-scoped reference read from another session', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'sess0',
        filename: 'user:profile.txt',
        artifact: {text: 'profile'},
      });
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'sess1',
        filename: 'ref.txt',
        artifact: {
          fileData: {
            fileUri: userUri('user:profile.txt'),
            mimeType: 'text/plain',
          },
        },
      });

      await expect(
        service.loadArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: 'sess1',
          filename: 'ref.txt',
        }),
      ).resolves.toEqual({text: 'profile'});
    });

    it('records no mime type for a stored reference', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'ref.txt',
        artifact: {
          fileData: {fileUri: sessionUri('source.txt'), mimeType: 'text/plain'},
        },
      });

      const version = await service.getArtifactVersion({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'ref.txt',
      });

      expect(version?.mimeType).toBeUndefined();
    });

    it.each([
      [
        'another user',
        `artifact://apps/${APP_NAME}/users/victim/sessions/${SESSION_ID}/artifacts/user:secret.txt/versions/0`,
      ],
      [
        'another app',
        `artifact://apps/other-app/users/${USER_ID}/sessions/${SESSION_ID}/artifacts/secret.txt/versions/0`,
      ],
    ])('rejects a reference owned by %s on save', async (_name, fileUri) => {
      const save = service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'ref.txt',
        artifact: {fileData: {fileUri, mimeType: 'text/plain'}},
      });

      await expect(save).rejects.toThrow(InputValidationError);
      await expect(save).rejects.toThrow('same app and user scope');
    });

    it('rejects a malformed reference URI on save', async () => {
      await expect(
        service.saveArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'ref.txt',
          artifact: {fileData: {fileUri: 'artifact://not-a-valid-uri'}},
        }),
      ).rejects.toThrow('Invalid artifact reference URI: artifact://');
    });

    it('rejects a session-scoped reference reached through a user-scoped one', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'sess0',
        filename: 'source.txt',
        artifact: {text: 'source'},
      });
      // A user-scoped pointer carries no session, so following it drops the
      // caller out of sess0. The session-scoped URI it holds is then out of
      // scope, which only the load-side check can catch.
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'sess0',
        filename: 'user:pointer',
        artifact: {fileData: {fileUri: sessionUri('source.txt', 0, 'sess0')}},
      });
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'sess0',
        filename: 'ref.txt',
        artifact: {fileData: {fileUri: userUri('user:pointer')}},
      });

      await expect(
        service.loadArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: 'sess0',
          filename: 'ref.txt',
        }),
      ).rejects.toThrow('same session scope');
    });

    it('rejects a reference chain that never reaches content', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'loop.txt',
        artifact: {fileData: {fileUri: sessionUri('loop.txt')}},
      });

      await expect(
        service.loadArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'loop.txt',
        }),
      ).rejects.toThrow('exceeded the maximum depth of 10');
    });
  });

  describe('path segment validation', () => {
    it.each(INVALID_SEGMENTS)(
      'rejects appName %s on save',
      async (appName, fragment) => {
        const save = service.saveArtifact({
          appName,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'user:safe.txt',
          artifact: {text: 'data'},
        });

        await expect(save).rejects.toThrow(InputValidationError);
        await expect(save).rejects.toThrow(fragment);
      },
    );

    it.each(INVALID_SEGMENTS)(
      'rejects userId %s on save',
      async (userId, fragment) => {
        await expect(
          service.saveArtifact({
            appName: APP_NAME,
            userId,
            sessionId: SESSION_ID,
            filename: 'user:safe.txt',
            artifact: {text: 'data'},
          }),
        ).rejects.toThrow(fragment);
      },
    );

    it.each(INVALID_SEGMENTS)(
      'rejects sessionId %s on save',
      async (sessionId, fragment) => {
        await expect(
          service.saveArtifact({
            appName: APP_NAME,
            userId: USER_ID,
            sessionId,
            filename: 'safe.txt',
            artifact: {text: 'data'},
          }),
        ).rejects.toThrow(fragment);
      },
    );

    it.each(INVALID_SEGMENTS)(
      'rejects appName %s on load',
      async (appName, fragment) => {
        await expect(
          service.loadArtifact({
            appName,
            userId: USER_ID,
            sessionId: SESSION_ID,
            filename: 'user:safe.txt',
          }),
        ).rejects.toThrow(fragment);
      },
    );

    it.each(INVALID_SEGMENTS)(
      'rejects userId %s on load',
      async (userId, fragment) => {
        await expect(
          service.loadArtifact({
            appName: APP_NAME,
            userId,
            sessionId: SESSION_ID,
            filename: 'user:safe.txt',
          }),
        ).rejects.toThrow(fragment);
      },
    );

    it.each(INVALID_SEGMENTS)(
      'rejects sessionId %s on load',
      async (sessionId, fragment) => {
        await expect(
          service.loadArtifact({
            appName: APP_NAME,
            userId: USER_ID,
            sessionId,
            filename: 'safe.txt',
          }),
        ).rejects.toThrow(fragment);
      },
    );

    it.each(INVALID_SEGMENTS)(
      'rejects appName %s on delete',
      async (appName, fragment) => {
        await expect(
          service.deleteArtifact({
            appName,
            userId: USER_ID,
            sessionId: SESSION_ID,
            filename: 'user:safe.txt',
          }),
        ).rejects.toThrow(fragment);
      },
    );

    it.each(INVALID_SEGMENTS)(
      'rejects userId %s on delete',
      async (userId, fragment) => {
        await expect(
          service.deleteArtifact({
            appName: APP_NAME,
            userId,
            sessionId: SESSION_ID,
            filename: 'user:safe.txt',
          }),
        ).rejects.toThrow(fragment);
      },
    );

    it.each(INVALID_SEGMENTS)(
      'rejects sessionId %s on delete',
      async (sessionId, fragment) => {
        await expect(
          service.deleteArtifact({
            appName: APP_NAME,
            userId: USER_ID,
            sessionId,
            filename: 'safe.txt',
          }),
        ).rejects.toThrow(fragment);
      },
    );

    it.each(INVALID_SEGMENTS)(
      'rejects appName %s on listArtifactKeys',
      async (appName, fragment) => {
        await expect(
          service.listArtifactKeys({
            appName,
            userId: USER_ID,
            sessionId: SESSION_ID,
          }),
        ).rejects.toThrow(fragment);
      },
    );

    it.each(INVALID_SEGMENTS)(
      'rejects userId %s on listArtifactKeys',
      async (userId, fragment) => {
        await expect(
          service.listArtifactKeys({
            appName: APP_NAME,
            userId,
            sessionId: SESSION_ID,
          }),
        ).rejects.toThrow(fragment);
      },
    );

    it.each(INVALID_SEGMENTS)(
      'rejects sessionId %s on listArtifactKeys',
      async (sessionId, fragment) => {
        await expect(
          service.listArtifactKeys({
            appName: APP_NAME,
            userId: USER_ID,
            sessionId,
          }),
        ).rejects.toThrow(fragment);
      },
    );

    it.each(INVALID_SEGMENTS)(
      'rejects appName %s on listVersions',
      async (appName, fragment) => {
        await expect(
          service.listVersions({
            appName,
            userId: USER_ID,
            sessionId: SESSION_ID,
            filename: 'user:safe.txt',
          }),
        ).rejects.toThrow(fragment);
      },
    );

    it('accepts a namespaced userId', async () => {
      await service.saveArtifact({
        appName: 'myapp',
        userId: 'group/user123',
        sessionId: 'sess123',
        filename: 'safe.txt',
        artifact: {inlineData: {data: 'ZGF0YQ==', mimeType: 'text/plain'}},
      });

      const loaded = await service.loadArtifact({
        appName: 'myapp',
        userId: 'group/user123',
        sessionId: 'sess123',
        filename: 'safe.txt',
      });

      expect(loaded?.inlineData?.data).toBe('ZGF0YQ==');
    });
  });

  describe('missing session', () => {
    it('rejects a reference whose target needs a session the URI does not name', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'source.txt',
        artifact: {text: 'source'},
      });
      // A user-scoped URI carries no session, but source.txt is session-scoped,
      // so resolving it reaches the path builder with no session at all.
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'ref.txt',
        artifact: {fileData: {fileUri: userUri('source.txt')}},
      });

      await expect(
        service.loadArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'ref.txt',
        }),
      ).rejects.toThrow(
        'Session ID must be provided for session-scoped artifacts.',
      );
    });
  });

  describe('artifact normalization', () => {
    it('accepts a camelCase artifact object', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'image.png',
        artifact: {inlineData: {mimeType: 'image/png', data: 'dGVzdA=='}},
      });

      const loaded = await service.loadArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'image.png',
      });

      expect(loaded?.inlineData?.mimeType).toBe('image/png');
      expect(loaded?.inlineData?.data).toBe('dGVzdA==');
    });

    it('accepts a snake_case artifact object', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'note.txt',
        artifact: {inline_data: {mime_type: 'text/plain', data: 'aGVsbG8='}},
      });

      const loaded = await service.loadArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'note.txt',
      });

      expect(loaded?.inlineData?.mimeType).toBe('text/plain');
      expect(loaded?.inlineData?.data).toBe('aGVsbG8=');
    });

    it('preserves an inline data display name', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'report.pdf',
        artifact: {
          inlineData: {
            mimeType: 'application/pdf',
            data: 'JVBERi0=',
            displayName: 'Quarterly report',
          },
        },
      });

      const loaded = await service.loadArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'report.pdf',
      });

      expect(loaded?.inlineData?.displayName).toBe('Quarterly report');
    });
  });

  describe('mime type inference', () => {
    it.each<[string, Part, string | undefined]>([
      ['a text artifact', {text: 'x'}, 'text/plain'],
      [
        'an inline data artifact',
        {inlineData: {mimeType: 'image/png', data: 'dGVzdA=='}},
        'image/png',
      ],
      [
        'an external file artifact',
        {
          fileData: {
            fileUri: 'gs://bucket/object',
            mimeType: 'application/pdf',
          },
        },
        'application/pdf',
      ],
    ])('reports %s', async (_name, artifact, expected) => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'artifact',
        artifact,
      });

      const version = await service.getArtifactVersion({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'artifact',
      });

      expect(version?.mimeType).toBe(expected);
    });
  });

  describe('empty artifact normalization', () => {
    it('reports an empty text artifact as absent', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'empty.txt',
        artifact: {text: ''},
      });

      await expect(
        service.loadArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'empty.txt',
        }),
      ).resolves.toBeUndefined();
    });

    it('reports inline data with no bytes as absent', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'empty.bin',
        artifact: {inlineData: {mimeType: 'text/plain', data: ''}},
      });

      await expect(
        service.loadArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'empty.bin',
        }),
      ).resolves.toBeUndefined();
    });

    it('still returns an artifact that has content', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'note.txt',
        artifact: {text: 'content'},
      });

      await expect(
        service.loadArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'note.txt',
        }),
      ).resolves.toEqual({text: 'content'});
    });

    it('reports a missing artifact and a missing version as absent', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'note.txt',
        artifact: {text: 'content'},
      });

      await expect(
        service.loadArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'missing.txt',
        }),
      ).resolves.toBeUndefined();
      await expect(
        service.loadArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'note.txt',
          version: 42,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
