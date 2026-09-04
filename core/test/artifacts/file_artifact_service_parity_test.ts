/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference tests ported from adk-python, so that the two implementations can
 * be compared name by name.
 *
 * Source: `adk-python:tests/unittests/artifacts/test_artifact_service.py` at
 * ref `main`. Each `it` keeps its original snake_case name. Where adk-js
 * deliberately behaves differently, the test asserts what adk-js does and the
 * comment above it names the divergence.
 */

import {FileArtifactService, InputValidationError} from '@google/adk';
import {Part} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {reserveVersionDir} from '../../src/artifacts/file_artifact_service.js';

const APP_NAME = 'app0';
const USER_ID = 'user0';
const SESSION_ID = '123';

/** Identifier values every artifact service must reject as a path segment. */
const INVALID_PATH_SEGMENTS = [
  '../escape',
  '../../etc',
  'foo/../../bar',
  '..',
  '.',
  'null\x00byte',
  '',
  '/etc/passwd',
  '/leading/slash',
  '\\leading\\backslash',
  'C:\\absolute',
  'C:/absolute',
  'C:drive-relative',
];

/** Filenames that must never resolve to a path outside the storage scope. */
const OUT_OF_SCOPE_FILENAMES = [
  '../escape.txt',
  '..\\escape.txt',
  'folder/../alias.txt',
  'folder\\..\\alias.txt',
  'folder/..\\alias.txt',
  'user:../escape.txt',
  'user:..\\escape.txt',
  'user:folder\\..\\alias.txt',
  '/absolute/path.txt',
  'user:/absolute/path.txt',
  'C:\\absolute\\path.txt',
  'C:/absolute/path.txt',
  'C:drive-relative.txt',
  '\\\\server\\share\\file.txt',
  '//server/share/file.txt',
  '\\rooted\\file.txt',
];

function textPart(text: string): Part {
  return {text};
}

function bytesPart(data: Buffer, mimeType: string): Part {
  return {inlineData: {data: data.toString('base64'), mimeType}};
}

/** Returns every `*.pending` staging directory left under a root. */
async function findPendingDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await fs.readdir(root, {withFileTypes: true}).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const full = path.join(root, entry.name);
    if (entry.name.endsWith('.pending')) {
      found.push(full);
    }
    found.push(...(await findPendingDirs(full)));
  }
  return found;
}

describe('FileArtifactService parity with adk-python', () => {
  let rootDir: string;
  let artifactRoot: string;
  let service: FileArtifactService;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-file-parity-'));
    artifactRoot = path.join(rootDir, 'artifacts');
    service = new FileArtifactService(artifactRoot);
  });

  afterEach(async () => {
    await fs.rm(rootDir, {recursive: true, force: true});
  });

  /** Builds the app-scoped session artifact directory for a filename. */
  function sessionArtifactDir(
    appName: string,
    userId: string,
    sessionId: string,
    ...filenameSegments: string[]
  ): string {
    return path.join(
      artifactRoot,
      'apps',
      appName,
      'users',
      userId,
      'sessions',
      sessionId,
      'artifacts',
      ...filenameSegments,
    );
  }

  describe('shared artifact service behaviour', () => {
    it('test_load_empty', async () => {
      await expect(
        service.loadArtifact({
          appName: 'test_app',
          userId: 'test_user',
          sessionId: 'session_id',
          filename: 'filename',
        }),
      ).resolves.toBeUndefined();
    });

    it('test_save_load_delete', async () => {
      const artifact = bytesPart(Buffer.from('test_data'), 'text/plain');
      const scope = {
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'file456',
      };

      await service.saveArtifact({...scope, artifact});
      const loaded = await service.loadArtifact(scope);
      expect(loaded?.inlineData?.data).toBe(artifact.inlineData?.data);

      await service.deleteArtifact(scope);
      await expect(service.loadArtifact(scope)).resolves.toBeUndefined();
    });

    it('test_list_keys', async () => {
      const artifact = bytesPart(Buffer.from('test_data'), 'text/plain');
      const filenames = ['file456', 'file789'];
      for (const filename of filenames) {
        await service.saveArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename,
          artifact,
        });
      }

      await expect(
        service.listArtifactKeys({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
        }),
      ).resolves.toEqual(filenames);
    });

    it('test_list_versions', async () => {
      const scope = {
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'file456',
      };
      for (let i = 0; i < 3; i++) {
        await service.saveArtifact({
          ...scope,
          artifact: bytesPart(Buffer.from([0, i]), 'text/plain'),
        });
      }

      await expect(service.listVersions(scope)).resolves.toEqual([0, 1, 2]);
    });

    it('test_nested_artifact_does_not_leak_versions_into_parent', async () => {
      const scope = {
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
      };
      const parent = textPart('parent v0');
      await service.saveArtifact({...scope, filename: 'doc', artifact: parent});
      for (let i = 0; i < 3; i++) {
        await service.saveArtifact({
          ...scope,
          filename: 'doc/nested',
          artifact: textPart(`nested v${i}`),
        });
      }

      await expect(
        service.listVersions({...scope, filename: 'doc'}),
      ).resolves.toEqual([0]);
      await expect(
        service.loadArtifact({...scope, filename: 'doc'}),
      ).resolves.toEqual(parent);
      await expect(
        service.saveArtifact({
          ...scope,
          filename: 'doc',
          artifact: textPart('parent v1'),
        }),
      ).resolves.toBe(1);
      await expect(
        service.listVersions({...scope, filename: 'doc/nested'}),
      ).resolves.toEqual([0, 1, 2]);
    });

    it('test_list_artifact_versions_excludes_nested_artifact', async () => {
      const scope = {
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
      };
      for (const filename of ['doc', 'doc/nested']) {
        await service.saveArtifact({
          ...scope,
          filename,
          artifact: textPart(filename),
        });
      }

      const versions = await service.listArtifactVersions({
        ...scope,
        filename: 'doc',
      });
      expect(versions.map((v) => v.version)).toEqual([0]);
      expect(versions[0].canonicalUri).toBe(
        pathToFileURL(
          sessionArtifactDir(
            APP_NAME,
            USER_ID,
            SESSION_ID,
            'doc',
            'versions',
            '0',
            'doc',
          ),
        ).toString(),
      );
    });

    it('test_delete_artifact_keeps_nested_artifact', async () => {
      const scope = {
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
      };
      const nested = textPart('nested v0');
      await service.saveArtifact({
        ...scope,
        filename: 'doc',
        artifact: textPart('parent v0'),
      });
      await service.saveArtifact({
        ...scope,
        filename: 'doc/nested',
        artifact: nested,
      });

      await service.deleteArtifact({...scope, filename: 'doc'});

      await expect(
        service.listVersions({...scope, filename: 'doc'}),
      ).resolves.toEqual([]);
      await expect(
        service.loadArtifact({...scope, filename: 'doc/nested'}),
      ).resolves.toEqual(nested);
    });

    it('test_list_keys_includes_nested_artifact', async () => {
      const scope = {
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
      };
      for (const filename of ['doc', 'doc/nested']) {
        await service.saveArtifact({
          ...scope,
          filename,
          artifact: textPart(filename),
        });
      }

      await expect(service.listArtifactKeys(scope)).resolves.toEqual([
        'doc',
        'doc/nested',
      ]);
    });

    it('test_list_keys_preserves_user_prefix', async () => {
      const scope = {
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
      };
      const artifact = bytesPart(Buffer.from('test_data'), 'text/plain');
      for (const filename of [
        'user:document.pdf',
        'user:image.png',
        'session_file.txt',
      ]) {
        await service.saveArtifact({...scope, filename, artifact});
      }

      const keys = await service.listArtifactKeys(scope);
      expect(keys.sort()).toEqual(
        ['user:document.pdf', 'user:image.png', 'session_file.txt'].sort(),
      );
    });

    it('test_save_load_text_artifact', async () => {
      for (const text of ['{"key": "value"}', 'some other text']) {
        const scope = {
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: `data-${text.length}.json`,
        };
        await service.saveArtifact({...scope, artifact: textPart(text)});

        const loaded = await service.loadArtifact(scope);
        expect(loaded?.text).toBe(text);
        expect(loaded?.inlineData).toBeUndefined();
      }
    });

    it('test_save_load_empty_text_artifact', async () => {
      const scope = {
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'empty.txt',
      };
      await service.saveArtifact({...scope, artifact: textPart('')});

      await expect(service.loadArtifact(scope)).resolves.toEqual({text: ''});
    });

    it('test_load_artifact_preserves_inline_data_display_name', async () => {
      const displayName = 'My Report (final).png';
      const scope = {
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: 'sess0',
        filename: 'artifact.bin',
      };
      await service.saveArtifact({
        ...scope,
        artifact: {
          inlineData: {
            mimeType: 'image/png',
            data: Buffer.from('\x89PNG\r\n\x1a\n').toString('base64'),
            displayName,
          },
        },
      });

      const loaded = await service.loadArtifact(scope);
      expect(loaded?.inlineData?.displayName).toBe(displayName);
    });

    /**
     * Divergence from adk-python: Python's `validate_path_segment` permits a
     * namespaced user ID such as `group/user123`, while adk-js validates every
     * identifier against a stricter allowlist that forbids a separator. adk-js
     * keeps its allowlist, so the reference test is inverted to pin the
     * rejection rather than the round-trip.
     */
    it('test_save_and_load_namespaced_user_id_succeeds', async () => {
      await expect(
        service.saveArtifact({
          appName: 'myapp',
          userId: 'group/user123',
          sessionId: 'sess123',
          filename: 'safe.txt',
          artifact: bytesPart(Buffer.from('data'), 'text/plain'),
        }),
      ).rejects.toThrow(InputValidationError);
    });
  });

  describe('identifier validation', () => {
    const artifact = bytesPart(Buffer.from('data'), 'text/plain');

    it.each(INVALID_PATH_SEGMENTS)(
      'test_save_artifact_rejects_traversal_in_app_name [%j]',
      async (appName) => {
        await expect(
          service.saveArtifact({
            appName,
            userId: 'user123',
            sessionId: SESSION_ID,
            filename: 'user:safe.txt',
            artifact,
          }),
        ).rejects.toThrow(/Invalid appName/);
      },
    );

    it.each(INVALID_PATH_SEGMENTS)(
      'test_save_artifact_rejects_traversal_in_user_id [%j]',
      async (userId) => {
        await expect(
          service.saveArtifact({
            appName: 'myapp',
            userId,
            sessionId: SESSION_ID,
            filename: 'user:safe.txt',
            artifact,
          }),
        ).rejects.toThrow(/Invalid userId/);
      },
    );

    it.each(INVALID_PATH_SEGMENTS)(
      'test_save_artifact_rejects_traversal_in_session_id [%j]',
      async (sessionId) => {
        await expect(
          service.saveArtifact({
            appName: 'myapp',
            userId: 'user123',
            sessionId,
            filename: 'safe.txt',
            artifact,
          }),
        ).rejects.toThrow(InputValidationError);
      },
    );

    it.each(INVALID_PATH_SEGMENTS)(
      'test_load_artifact_rejects_traversal_in_app_name [%j]',
      async (appName) => {
        await expect(
          service.loadArtifact({
            appName,
            userId: 'user123',
            sessionId: SESSION_ID,
            filename: 'user:safe.txt',
          }),
        ).rejects.toThrow(/Invalid appName/);
      },
    );

    it.each(INVALID_PATH_SEGMENTS)(
      'test_load_artifact_rejects_traversal_in_user_id [%j]',
      async (userId) => {
        await expect(
          service.loadArtifact({
            appName: 'myapp',
            userId,
            sessionId: SESSION_ID,
            filename: 'user:safe.txt',
          }),
        ).rejects.toThrow(/Invalid userId/);
      },
    );

    it.each(INVALID_PATH_SEGMENTS)(
      'test_load_artifact_rejects_traversal_in_session_id [%j]',
      async (sessionId) => {
        await expect(
          service.loadArtifact({
            appName: 'myapp',
            userId: 'user123',
            sessionId,
            filename: 'safe.txt',
          }),
        ).rejects.toThrow(InputValidationError);
      },
    );

    it.each(INVALID_PATH_SEGMENTS)(
      'test_delete_artifact_rejects_traversal_in_app_name [%j]',
      async (appName) => {
        await expect(
          service.deleteArtifact({
            appName,
            userId: 'user123',
            sessionId: SESSION_ID,
            filename: 'user:safe.txt',
          }),
        ).rejects.toThrow(/Invalid appName/);
      },
    );

    it.each(INVALID_PATH_SEGMENTS)(
      'test_delete_artifact_rejects_traversal_in_user_id [%j]',
      async (userId) => {
        await expect(
          service.deleteArtifact({
            appName: 'myapp',
            userId,
            sessionId: SESSION_ID,
            filename: 'user:safe.txt',
          }),
        ).rejects.toThrow(/Invalid userId/);
      },
    );

    it.each(INVALID_PATH_SEGMENTS)(
      'test_delete_artifact_rejects_traversal_in_session_id [%j]',
      async (sessionId) => {
        await expect(
          service.deleteArtifact({
            appName: 'myapp',
            userId: 'user123',
            sessionId,
            filename: 'safe.txt',
          }),
        ).rejects.toThrow(InputValidationError);
      },
    );

    it.each(INVALID_PATH_SEGMENTS)(
      'test_list_artifact_keys_rejects_traversal_in_app_name [%j]',
      async (appName) => {
        await expect(
          service.listArtifactKeys({
            appName,
            userId: 'user123',
            sessionId: SESSION_ID,
          }),
        ).rejects.toThrow(/Invalid appName/);
      },
    );

    it.each(INVALID_PATH_SEGMENTS)(
      'test_list_artifact_keys_rejects_traversal_in_user_id [%j]',
      async (userId) => {
        await expect(
          service.listArtifactKeys({
            appName: 'myapp',
            userId,
            sessionId: SESSION_ID,
          }),
        ).rejects.toThrow(/Invalid userId/);
      },
    );

    it.each(INVALID_PATH_SEGMENTS)(
      'test_list_artifact_keys_rejects_traversal_in_session_id [%j]',
      async (sessionId) => {
        await expect(
          service.listArtifactKeys({
            appName: 'myapp',
            userId: 'user123',
            sessionId,
          }),
        ).rejects.toThrow(/Invalid sessionId/);
      },
    );

    it.each(OUT_OF_SCOPE_FILENAMES)(
      'test_file_save_artifact_rejects_out_of_scope_paths [%j]',
      async (filename) => {
        await expect(
          service.saveArtifact({
            appName: 'myapp',
            userId: 'user123',
            sessionId: 'sess123',
            filename,
            artifact: textPart('content'),
          }),
        ).rejects.toThrow(InputValidationError);
      },
    );

    it('test_file_save_artifact_rejects_absolute_path_within_scope', async () => {
      const absoluteInScope = path.join(
        artifactRoot,
        'apps',
        'myapp',
        'users',
        'user123',
        'artifacts',
        'diagram.png',
      );

      await expect(
        service.saveArtifact({
          appName: 'myapp',
          userId: 'user123',
          sessionId: SESSION_ID,
          filename: absoluteInScope,
          artifact: textPart('content'),
        }),
      ).rejects.toThrow(InputValidationError);
    });
  });

  describe('app scoping', () => {
    /**
     * The reference parametrizes this over a session-scoped and a user-scoped
     * artifact. `CompositeSessionKey.sessionId` is required in adk-js, so the
     * user-scoped case is expressed with the `user:` filename prefix, which is
     * the other route into the user namespace.
     */
    it.each([['report.txt'], ['user:profile.txt']])(
      'test_file_artifacts_are_isolated_by_app [%s]',
      async (filename) => {
        const scope = {userId: 'user', sessionId: 'session', filename};
        const keysScope = {userId: 'user', sessionId: 'session'};

        await expect(
          service.saveArtifact({
            appName: 'app-a',
            artifact: textPart('secret-a'),
            ...scope,
          }),
        ).resolves.toBe(0);

        await expect(
          service.loadArtifact({appName: 'app-b', ...scope}),
        ).resolves.toBeUndefined();
        await expect(
          service.listArtifactKeys({appName: 'app-b', ...keysScope}),
        ).resolves.toEqual([]);
        await expect(
          service.listVersions({appName: 'app-b', ...scope}),
        ).resolves.toEqual([]);
        await expect(
          service.listArtifactVersions({appName: 'app-b', ...scope}),
        ).resolves.toEqual([]);
        await expect(
          service.getArtifactVersion({appName: 'app-b', ...scope}),
        ).resolves.toBeUndefined();

        await expect(
          service.saveArtifact({
            appName: 'app-b',
            artifact: textPart('secret-b'),
            ...scope,
          }),
        ).resolves.toBe(0);
        await expect(
          service.loadArtifact({appName: 'app-a', ...scope}),
        ).resolves.toEqual({text: 'secret-a'});

        await service.deleteArtifact({appName: 'app-b', ...scope});
        await expect(
          service.loadArtifact({appName: 'app-b', ...scope}),
        ).resolves.toBeUndefined();
        await expect(
          service.loadArtifact({appName: 'app-a', ...scope}),
        ).resolves.toEqual({text: 'secret-a'});
      },
    );

    it.each([['app-a'], ['app-b']])(
      'test_file_artifact_reads_never_serve_the_unscoped_layout [%s]',
      async (appName) => {
        await writeUnscopedArtifact(artifactRoot, 'older', 'legacy');

        const scope = {
          userId: 'user',
          sessionId: 'session',
          filename: 'report.txt',
        };
        await expect(
          service.loadArtifact({appName, ...scope}),
        ).resolves.toBeUndefined();
        await expect(
          service.listVersions({appName, ...scope}),
        ).resolves.toEqual([]);
        await expect(
          service.listArtifactVersions({appName, ...scope}),
        ).resolves.toEqual([]);
        await expect(
          service.getArtifactVersion({appName, ...scope}),
        ).resolves.toBeUndefined();
        await expect(
          service.listArtifactKeys({
            appName,
            userId: 'user',
            sessionId: 'session',
          }),
        ).resolves.toEqual([]);
      },
    );

    it('test_file_artifact_saves_never_reuse_unscoped_layout', async () => {
      await writeUnscopedArtifact(artifactRoot, 'older', 'legacy');
      const scope = {
        appName: 'app-a',
        userId: 'user',
        sessionId: 'session',
        filename: 'report.txt',
      };

      await expect(
        service.saveArtifact({...scope, artifact: textPart('current')}),
      ).resolves.toBe(0);
      await expect(
        fs.stat(path.join(artifactRoot, 'apps', 'app-a', 'users', 'user')),
      ).resolves.toBeDefined();
      await expect(service.loadArtifact(scope)).resolves.toEqual({
        text: 'current',
      });
      await expect(service.listVersions(scope)).resolves.toEqual([0]);
      await expect(
        service.loadArtifact({...scope, version: 1}),
      ).resolves.toBeUndefined();

      await service.deleteArtifact(scope);
      await expect(service.loadArtifact(scope)).resolves.toBeUndefined();
    });

    it('test_file_artifact_delete_only_removes_the_calling_apps_copy', async () => {
      await writeUnscopedArtifact(artifactRoot, 'legacy');
      const unscopedDir = path.join(
        artifactRoot,
        'users',
        'user',
        'sessions',
        'session',
        'artifacts',
        'report.txt',
      );
      const scope = {
        userId: 'user',
        sessionId: 'session',
        filename: 'report.txt',
      };
      await service.saveArtifact({
        appName: 'app-a',
        artifact: textPart('secret-a'),
        ...scope,
      });

      await service.deleteArtifact({appName: 'app-b', ...scope});

      expect((await fs.stat(unscopedDir)).isDirectory()).toBe(true);
      await expect(
        service.loadArtifact({appName: 'app-a', ...scope}),
      ).resolves.toEqual({text: 'secret-a'});
      await expect(
        service.listVersions({appName: 'app-a', ...scope}),
      ).resolves.toEqual([0]);
    });
  });

  describe('metadata and canonical URIs', () => {
    /**
     * Divergence from adk-python: `ArtifactVersion` on this branch has no
     * `createTime`, which the reference pops before comparing. The assertion
     * therefore covers the fields adk-js persists today.
     */
    it('test_file_metadata_camelcase', async () => {
      await service.saveArtifact({
        appName: 'myapp',
        userId: 'user123',
        sessionId: 'sess789',
        filename: 'docs/report.txt',
        artifact: bytesPart(
          Buffer.from('binary-content'),
          'application/octet-stream',
        ),
      });

      const versionDir = sessionArtifactDir(
        'myapp',
        'user123',
        'sess789',
        'docs',
        'report.txt',
        'versions',
        '0',
      );
      const rawMetadata = await fs.readFile(
        path.join(versionDir, 'metadata.json'),
        'utf-8',
      );
      expect(rawMetadata).not.toContain('\n');

      const payloadPath = path.join(versionDir, 'report.txt');
      expect(JSON.parse(rawMetadata)).toEqual({
        fileName: 'docs/report.txt',
        mimeType: 'application/octet-stream',
        canonicalUri: pathToFileURL(payloadPath).toString(),
        version: 0,
        customMetadata: {},
      });
      await expect(fs.readFile(payloadPath, 'utf-8')).resolves.toBe(
        'binary-content',
      );
    });

    it('test_file_list_artifact_versions', async () => {
      const customMetadata = {origin: 'unit-test'};
      const scope = {
        appName: 'myapp',
        userId: 'user123',
        sessionId: 'sess789',
        filename: 'docs/report.txt',
      };
      await service.saveArtifact({
        ...scope,
        artifact: bytesPart(
          Buffer.from('binary-content'),
          'application/octet-stream',
        ),
        customMetadata,
      });

      const versions = await service.listArtifactVersions(scope);
      expect(versions).toHaveLength(1);
      const payloadPath = sessionArtifactDir(
        'myapp',
        'user123',
        'sess789',
        'docs',
        'report.txt',
        'versions',
        '0',
        'report.txt',
      );
      expect(versions[0].version).toBe(0);
      expect(versions[0].canonicalUri).toBe(
        pathToFileURL(payloadPath).toString(),
      );
      expect(versions[0].customMetadata).toEqual(customMetadata);
      await expect(fs.readFile(payloadPath, 'utf-8')).resolves.toBe(
        'binary-content',
      );

      const fetched = await service.getArtifactVersion({...scope, version: 0});
      expect(fetched).toEqual(versions[0]);
      const latest = await service.getArtifactVersion(scope);
      expect(latest).toEqual(versions[0]);
    });

    it('test_load_artifact_ignores_canonical_uri_from_metadata', async () => {
      const secret = path.join(rootDir, 'secret.txt');
      await fs.writeFile(secret, 'TOP-SECRET', 'utf-8');
      // The payload is deliberately absent. That is the state the delete/load
      // race produced, and it is what previously fell through to canonicalUri.
      await writeTamperedMetadata(
        artifactRoot,
        'poisoned.txt',
        pathToFileURL(secret).toString(),
      );

      await expect(
        service.loadArtifact({
          appName: 'app',
          userId: 'user',
          sessionId: 'session',
          filename: 'poisoned.txt',
        }),
      ).resolves.toBeUndefined();
    });

    it('test_get_artifact_version_ignores_canonical_uri_from_metadata', async () => {
      await writeTamperedMetadata(
        artifactRoot,
        'poisoned.txt',
        'file:///etc/passwd',
      );

      const artifactVersion = await service.getArtifactVersion({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'poisoned.txt',
        version: 0,
      });

      expect(artifactVersion).toBeDefined();
      expect(artifactVersion?.canonicalUri).not.toBe('file:///etc/passwd');
      expect(artifactVersion?.canonicalUri).toContain(
        pathToFileURL(artifactRoot).toString(),
      );
    });

    it('test_list_artifact_keys_survives_metadata_path_shadowed_by_dir', async () => {
      // Creates `<user scope>/a/versions/0/metadata.json` as a *directory*,
      // which made every subsequent listing for this user fail.
      await service.saveArtifact({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'user:a/versions/0/metadata.json/payload.txt',
        artifact: textPart('x'),
      });

      await expect(
        service.listArtifactKeys({
          appName: 'app',
          userId: 'user',
          sessionId: 'session',
        }),
      ).resolves.toEqual(['user:a']);
    });
  });

  describe('atomic version publishing', () => {
    const scope = {
      appName: 'app',
      userId: 'user',
      sessionId: 'session',
      filename: 'report.txt',
    };

    it('test_file_save_artifact_reserves_concurrent_versions', async () => {
      const saved = await Promise.all([
        service.saveArtifact({...scope, artifact: textPart('first')}),
        service.saveArtifact({...scope, artifact: textPart('second')}),
      ]);

      expect([...saved].sort()).toEqual([0, 1]);
      await expect(service.listVersions(scope)).resolves.toEqual([0, 1]);

      const loadedTexts = new Set<string>();
      for (const version of saved) {
        const artifact = await service.loadArtifact({...scope, version});
        expect(artifact?.text).toBeDefined();
        loadedTexts.add(artifact?.text ?? '');
      }
      expect(loadedTexts).toEqual(new Set(['first', 'second']));

      // Two savers that both read the same version list must still reserve
      // different numbers, whatever order the event loop interleaves them in.
      const versionsDir = path.join(
        sessionArtifactDir('app', 'user', 'session', 'report.txt'),
        'versions',
      );
      const [firstReservation, secondReservation] = await Promise.all([
        reserveVersionDir(versionsDir, 2),
        reserveVersionDir(versionsDir, 2),
      ]);
      expect(
        [firstReservation.version, secondReservation.version].sort(),
      ).toEqual([2, 3]);
      expect(firstReservation.stagingDir).not.toBe(
        secondReservation.stagingDir,
      );
    });

    it('test_file_save_artifact_does_not_publish_failed_write', async () => {
      await expect(
        service.saveArtifact({
          ...scope,
          artifact: {inlineData: {mimeType: 'image/png'}},
        }),
      ).rejects.toThrow(InputValidationError);

      await expect(service.listVersions(scope)).resolves.toEqual([]);
      await expect(service.loadArtifact(scope)).resolves.toBeUndefined();
      // listVersions ignores staging directories, so assert on disk that the
      // failed reservation was released rather than merely hidden.
      await expect(findPendingDirs(artifactRoot)).resolves.toEqual([]);
    });

    it('test_file_save_artifact_stages_binary_payload', async () => {
      const payload = Buffer.from(Array.from({length: 256}, (_, i) => i));
      const binaryScope = {...scope, filename: 'photo.png'};

      const version = await service.saveArtifact({
        ...binaryScope,
        artifact: bytesPart(payload, 'image/png'),
      });

      expect(version).toBe(0);
      const loaded = await service.loadArtifact(binaryScope);
      expect(loaded?.inlineData?.mimeType).toBe('image/png');
      expect(Buffer.from(loaded?.inlineData?.data ?? '', 'base64')).toEqual(
        payload,
      );
      await expect(findPendingDirs(artifactRoot)).resolves.toEqual([]);
    });

    it('test_file_save_artifact_skips_abandoned_reservation', async () => {
      const versionsDir = path.join(
        sessionArtifactDir('app', 'user', 'session', 'report.txt'),
        'versions',
      );
      await fs.mkdir(path.join(versionsDir, '.0.pending'), {recursive: true});

      const version = await service.saveArtifact({
        ...scope,
        artifact: textPart('complete'),
      });

      expect(version).toBe(1);
      await expect(service.listVersions(scope)).resolves.toEqual([1]);
      // The abandoned reservation holds version 0 permanently; it is skipped,
      // not reclaimed.
      expect(
        (await fs.stat(path.join(versionsDir, '.0.pending'))).isDirectory(),
      ).toBe(true);
    });

    it('test_file_save_artifact_never_republishes_existing_version', async () => {
      await service.saveArtifact({...scope, artifact: textPart('first')});
      const versionsDir = path.join(
        sessionArtifactDir('app', 'user', 'session', 'report.txt'),
        'versions',
      );

      // A save that read the version list before a concurrent save published
      // version 0 starts its reservation at 0. It must not land on the version
      // already on disk.
      const reservation = await reserveVersionDir(versionsDir, 0);

      expect(reservation.version).toBe(1);
      expect(reservation.versionDir).toBe(path.join(versionsDir, '1'));
      await expect(
        service.loadArtifact({...scope, version: 0}),
      ).resolves.toEqual({text: 'first'});
    });

    it('test_save_artifact_discards_version_when_metadata_write_fails', async () => {
      await service.saveArtifact({...scope, artifact: textPart('v0')});

      // customMetadata is caller controlled and can be made unserializable.
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      await expect(
        service.saveArtifact({
          ...scope,
          artifact: textPart('poison'),
          customMetadata: circular,
        }),
      ).rejects.toThrow(TypeError);

      await expect(service.listVersions(scope)).resolves.toEqual([0]);
      await expect(service.loadArtifact(scope)).resolves.toEqual({text: 'v0'});
      await expect(findPendingDirs(artifactRoot)).resolves.toEqual([]);
    });

    it.skipIf(process.platform === 'win32')(
      'test_metadata_and_payload_share_permissions',
      async () => {
        await service.saveArtifact({...scope, artifact: textPart('payload')});
        const versionDir = path.join(
          sessionArtifactDir('app', 'user', 'session', 'report.txt'),
          'versions',
          '0',
        );

        const payloadMode = (await fs.stat(path.join(versionDir, 'report.txt')))
          .mode;
        const metadataMode = (
          await fs.stat(path.join(versionDir, 'metadata.json'))
        ).mode;

        expect(metadataMode & 0o777).toBe(payloadMode & 0o777);
      },
    );
  });

  describe('reserved and malformed content', () => {
    it.each([
      'metadata.json',
      'nested/metadata.json',
      'user:metadata.json',
      // Case variants: on a case-insensitive filesystem these resolve to the
      // metadata document too, so the name has to be rejected caselessly.
      'Metadata.json',
      'METADATA.JSON',
      'nested/MetaData.Json',
    ])(
      'test_save_artifact_rejects_reserved_metadata_filename [%s]',
      async (filename) => {
        await expect(
          service.saveArtifact({
            appName: 'app',
            userId: 'user',
            sessionId: 'session',
            filename,
            artifact: textPart('payload'),
          }),
        ).rejects.toThrow(InputValidationError);
      },
    );

    it('test_reserved_metadata_filename_stays_deletable', async () => {
      const artifactDir = sessionArtifactDir(
        'app',
        'user',
        'session',
        'metadata.json',
      );
      const versionDir = path.join(artifactDir, 'versions', '0');
      await fs.mkdir(versionDir, {recursive: true});
      await fs.writeFile(
        path.join(versionDir, 'metadata.json'),
        JSON.stringify({fileName: 'metadata.json', version: 0}),
        'utf-8',
      );
      const scope = {
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'metadata.json',
      };

      // Reading must not raise, and deleting must actually remove it.
      await service.loadArtifact(scope);
      await service.deleteArtifact(scope);

      await expect(fs.stat(artifactDir)).rejects.toThrow();
    });

    it('test_save_artifact_rejects_inline_data_without_data', async () => {
      await expect(
        service.saveArtifact({
          appName: 'app',
          userId: 'user',
          sessionId: 'session',
          filename: 'img.png',
          artifact: {inlineData: {mimeType: 'image/png'}},
        }),
      ).rejects.toThrow(InputValidationError);
    });

    it('test_save_artifact_allows_explicitly_empty_inline_data', async () => {
      const scope = {
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'empty.png',
      };
      await service.saveArtifact({
        ...scope,
        artifact: {inlineData: {mimeType: 'image/png', data: ''}},
      });

      const loaded = await service.loadArtifact(scope);
      // Empty, but present -- distinct from the missing-data case above.
      expect(loaded?.inlineData?.data).toBe('');
    });
  });
});

/** Writes an artifact in the layout used before storage was app-scoped. */
async function writeUnscopedArtifact(
  root: string,
  ...texts: string[]
): Promise<void> {
  const versionsDir = path.join(
    root,
    'users',
    'user',
    'sessions',
    'session',
    'artifacts',
    'report.txt',
    'versions',
  );
  for (const [version, text] of texts.entries()) {
    const versionDir = path.join(versionsDir, String(version));
    await fs.mkdir(versionDir, {recursive: true});
    const payloadPath = path.join(versionDir, 'report.txt');
    await fs.writeFile(payloadPath, text, 'utf-8');
    await fs.writeFile(
      path.join(versionDir, 'metadata.json'),
      JSON.stringify({
        fileName: 'report.txt',
        version,
        canonicalUri: pathToFileURL(payloadPath).toString(),
        customMetadata: {},
      }),
      'utf-8',
    );
  }
}

/**
 * Writes a version-0 metadata document whose `canonicalUri` points somewhere a
 * caller must never be sent, and no payload beside it.
 */
async function writeTamperedMetadata(
  root: string,
  artifactName: string,
  canonicalUri: string,
): Promise<void> {
  const versionDir = path.join(
    root,
    'apps',
    'app',
    'users',
    'user',
    'sessions',
    'session',
    'artifacts',
    artifactName,
    'versions',
    '0',
  );
  await fs.mkdir(versionDir, {recursive: true});
  await fs.writeFile(
    path.join(versionDir, 'metadata.json'),
    JSON.stringify({
      fileName: artifactName,
      version: 0,
      canonicalUri,
      customMetadata: {},
    }),
    'utf-8',
  );
}
