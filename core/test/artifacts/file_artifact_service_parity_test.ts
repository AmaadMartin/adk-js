/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour ported from adk-python `FileArtifactService`.
 *
 * Source: `tests/unittests/artifacts/test_artifact_service.py` on
 * google/adk-python `main`. Each `it(...)` keeps the Python test name verbatim
 * so a reviewer can grep for it. Divergences are commented where they occur.
 */

import {FileArtifactService, InputValidationError} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  getAppRoot,
  getSessionArtifactsDir,
  getUserRoot,
} from '../../src/artifacts/file_artifact_service.js';

const UNSCOPED_SCOPE = {
  userId: 'user',
  sessionId: 'session',
  filename: 'report.txt',
};

/** Returns the session-scoped directory an artifact is stored in. */
function sessionArtifactDir(
  root: string,
  appName: string,
  userId: string,
  sessionId: string,
  artifactName: string,
): string {
  return path.join(
    getSessionArtifactsDir(
      getUserRoot(getAppRoot(root, appName), userId),
      sessionId,
    ),
    artifactName,
  );
}

/** Writes an artifact in the layout used before storage was app-scoped. */
async function writeUnscopedArtifact(
  root: string,
  ...texts: string[]
): Promise<string> {
  const artifactDir = path.join(
    root,
    'users',
    'user',
    'sessions',
    'session',
    'artifacts',
    'report.txt',
  );
  for (const [version, text] of texts.entries()) {
    const versionDir = path.join(artifactDir, 'versions', String(version));
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
  return artifactDir;
}

/**
 * Writes a metadata document naming `canonicalUri`, bypassing the service.
 *
 * This reproduces the on-disk state an attacker can otherwise reach by saving
 * an artifact that overwrites its own metadata document, so the load path can
 * be exercised against a tampered artifact tree directly.
 */
async function writeTamperedMetadata(
  root: string,
  artifactName: string,
  canonicalUri: string,
): Promise<void> {
  const versionDir = path.join(
    sessionArtifactDir(root, 'app', 'user', 'session', artifactName),
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

/** Returns every staging directory left anywhere beneath the root. */
async function findPendingDirs(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.pending'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Returns the permission bits of a file. */
async function fileMode(target: string): Promise<number> {
  return (await fs.stat(target)).mode & 0o777;
}

describe('FileArtifactService adk-python parity', () => {
  let root: string;
  let service: FileArtifactService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-parity-'));
    service = new FileArtifactService(root);
  });

  afterEach(async () => {
    await fs.rm(root, {recursive: true, force: true});
  });

  describe('app-scoped storage layout', () => {
    // adk-js requires `sessionId`, so the Python `session_id=None` case becomes
    // a `user:`-prefixed filename with a session id that is never used.
    for (const filename of ['report.txt', 'user:profile.txt']) {
      it(`test_file_artifacts_are_isolated_by_app (${filename})`, async () => {
        const scope = {userId: 'user', sessionId: 'session', filename};

        expect(
          await service.saveArtifact({
            ...scope,
            appName: 'app-a',
            artifact: {text: 'secret-a'},
          }),
        ).toBe(0);

        expect(
          await service.loadArtifact({...scope, appName: 'app-b'}),
        ).toBeUndefined();
        expect(
          await service.listArtifactKeys({
            appName: 'app-b',
            userId: 'user',
            sessionId: 'session',
          }),
        ).toEqual([]);
        expect(
          await service.listVersions({...scope, appName: 'app-b'}),
        ).toEqual([]);
        expect(
          await service.listArtifactVersions({...scope, appName: 'app-b'}),
        ).toEqual([]);
        expect(
          await service.getArtifactVersion({...scope, appName: 'app-b'}),
        ).toBeUndefined();

        expect(
          await service.saveArtifact({
            ...scope,
            appName: 'app-b',
            artifact: {text: 'secret-b'},
          }),
        ).toBe(0);
        expect(
          (await service.loadArtifact({...scope, appName: 'app-a'}))?.text,
        ).toBe('secret-a');

        await service.deleteArtifact({...scope, appName: 'app-b'});
        expect(
          await service.loadArtifact({...scope, appName: 'app-b'}),
        ).toBeUndefined();
        expect(
          (await service.loadArtifact({...scope, appName: 'app-a'}))?.text,
        ).toBe('secret-a');
      });
    }

    for (const appName of ['app-a', 'app-b']) {
      it(`test_file_artifact_reads_never_serve_the_unscoped_layout (${appName})`, async () => {
        await writeUnscopedArtifact(root, 'older', 'legacy');

        expect(
          await service.loadArtifact({...UNSCOPED_SCOPE, appName}),
        ).toBeUndefined();
        expect(
          await service.listVersions({...UNSCOPED_SCOPE, appName}),
        ).toEqual([]);
        expect(
          await service.listArtifactVersions({...UNSCOPED_SCOPE, appName}),
        ).toEqual([]);
        expect(
          await service.getArtifactVersion({...UNSCOPED_SCOPE, appName}),
        ).toBeUndefined();
        expect(
          await service.listArtifactKeys({
            appName,
            userId: 'user',
            sessionId: 'session',
          }),
        ).toEqual([]);
      });
    }

    it('test_file_artifact_saves_never_reuse_unscoped_layout', async () => {
      await writeUnscopedArtifact(root, 'older', 'legacy');

      expect(
        await service.saveArtifact({
          ...UNSCOPED_SCOPE,
          appName: 'app-a',
          artifact: {text: 'current'},
        }),
      ).toBe(0);
      expect(
        (
          await fs.stat(path.join(root, 'apps', 'app-a', 'users', 'user'))
        ).isDirectory(),
      ).toBe(true);
      expect(
        (await service.loadArtifact({...UNSCOPED_SCOPE, appName: 'app-a'}))
          ?.text,
      ).toBe('current');
      // Version numbering restarts and the older versions stop being served.
      expect(
        await service.listVersions({...UNSCOPED_SCOPE, appName: 'app-a'}),
      ).toEqual([0]);
      expect(
        await service.loadArtifact({
          ...UNSCOPED_SCOPE,
          appName: 'app-a',
          version: 1,
        }),
      ).toBeUndefined();

      await service.deleteArtifact({...UNSCOPED_SCOPE, appName: 'app-a'});
      expect(
        await service.loadArtifact({...UNSCOPED_SCOPE, appName: 'app-a'}),
      ).toBeUndefined();
    });

    it('test_file_artifact_delete_only_removes_the_calling_apps_copy', async () => {
      const unscopedDir = await writeUnscopedArtifact(root, 'legacy');
      await service.saveArtifact({
        ...UNSCOPED_SCOPE,
        appName: 'app-a',
        artifact: {text: 'secret-a'},
      });

      await service.deleteArtifact({...UNSCOPED_SCOPE, appName: 'app-b'});

      expect((await fs.stat(unscopedDir)).isDirectory()).toBe(true);
      expect(
        (await service.loadArtifact({...UNSCOPED_SCOPE, appName: 'app-a'}))
          ?.text,
      ).toBe('secret-a');
      expect(
        await service.listVersions({...UNSCOPED_SCOPE, appName: 'app-a'}),
      ).toEqual([0]);
    });
  });

  describe('nested artifacts', () => {
    const scope = {appName: 'app0', userId: 'user0', sessionId: '123'};

    it('test_nested_artifact_does_not_leak_versions_into_parent', async () => {
      await service.saveArtifact({
        ...scope,
        filename: 'doc',
        artifact: {text: 'parent v0'},
      });
      // Give the nested artifact more versions than the parent has, so a leak
      // would push max(versions) past any version "doc" actually has.
      for (let i = 0; i < 3; i++) {
        await service.saveArtifact({
          ...scope,
          filename: 'doc/nested',
          artifact: {text: `nested v${i}`},
        });
      }

      expect(await service.listVersions({...scope, filename: 'doc'})).toEqual([
        0,
      ]);
      expect(
        (await service.loadArtifact({...scope, filename: 'doc'}))?.text,
      ).toBe('parent v0');
      expect(
        await service.saveArtifact({
          ...scope,
          filename: 'doc',
          artifact: {text: 'parent v1'},
        }),
      ).toBe(1);
      expect(
        await service.listVersions({...scope, filename: 'doc/nested'}),
      ).toEqual([0, 1, 2]);
    });

    it('test_list_artifact_versions_excludes_nested_artifact', async () => {
      for (const filename of ['doc', 'doc/nested']) {
        await service.saveArtifact({
          ...scope,
          filename,
          artifact: {text: filename},
        });
      }

      const versions = await service.listArtifactVersions({
        ...scope,
        filename: 'doc',
      });

      expect(versions.map((v) => v.version)).toEqual([0]);
      // The returned handle must address "doc", not the nested artifact.
      expect(versions[0].canonicalUri).toBe(
        pathToFileURL(
          path.join(
            sessionArtifactDir(root, 'app0', 'user0', '123', 'doc'),
            'versions',
            '0',
            'doc',
          ),
        ).toString(),
      );
    });

    it('test_delete_artifact_keeps_nested_artifact', async () => {
      await service.saveArtifact({
        ...scope,
        filename: 'doc',
        artifact: {text: 'parent v0'},
      });
      await service.saveArtifact({
        ...scope,
        filename: 'doc/nested',
        artifact: {text: 'nested v0'},
      });

      await service.deleteArtifact({...scope, filename: 'doc'});

      expect(await service.listVersions({...scope, filename: 'doc'})).toEqual(
        [],
      );
      expect(
        (await service.loadArtifact({...scope, filename: 'doc/nested'}))?.text,
      ).toBe('nested v0');
    });

    it('test_list_keys_includes_nested_artifact', async () => {
      for (const filename of ['doc', 'doc/nested']) {
        await service.saveArtifact({
          ...scope,
          filename,
          artifact: {text: filename},
        });
      }

      expect(await service.listArtifactKeys(scope)).toEqual([
        'doc',
        'doc/nested',
      ]);
    });
  });

  describe('atomic version publication', () => {
    const scope = {
      appName: 'app',
      userId: 'user',
      sessionId: 'session',
      filename: 'report.txt',
    };

    it('test_file_save_artifact_reserves_concurrent_versions', async () => {
      const saved = await Promise.all([
        service.saveArtifact({...scope, artifact: {text: 'first'}}),
        service.saveArtifact({...scope, artifact: {text: 'second'}}),
      ]);

      expect([...saved].sort()).toEqual([0, 1]);
      expect(await service.listVersions(scope)).toEqual([0, 1]);

      const texts = new Set<string>();
      for (const version of saved) {
        const artifact = await service.loadArtifact({...scope, version});
        expect(artifact?.text).toBeDefined();
        texts.add(artifact!.text!);
      }
      expect(texts).toEqual(new Set(['first', 'second']));
    });

    it('test_file_save_artifact_does_not_publish_failed_write', async () => {
      // `customMetadata` is caller-controlled and can be made unserializable,
      // which fails the save at the point Python's patched `_write_metadata`
      // does.
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      await expect(
        service.saveArtifact({
          ...scope,
          artifact: {text: 'incomplete'},
          customMetadata: circular,
        }),
      ).rejects.toThrow(TypeError);

      expect(await service.listVersions(scope)).toEqual([]);
      expect(await service.loadArtifact(scope)).toBeUndefined();
      // listVersions ignores staging directories, so assert on disk that the
      // failed reservation was released rather than merely hidden.
      expect(await findPendingDirs(root)).toEqual([]);
    });

    it('test_file_save_artifact_stages_binary_payload', async () => {
      const payload = Buffer.from(Array.from({length: 256}, (_, i) => i));

      const version = await service.saveArtifact({
        ...scope,
        filename: 'photo.png',
        artifact: {
          inlineData: {
            mimeType: 'image/png',
            data: payload.toString('base64'),
          },
        },
      });

      expect(version).toBe(0);
      const loaded = await service.loadArtifact({
        ...scope,
        filename: 'photo.png',
      });
      expect(loaded?.inlineData?.mimeType).toBe('image/png');
      expect(Buffer.from(loaded!.inlineData!.data!, 'base64')).toEqual(payload);
      expect(await findPendingDirs(root)).toEqual([]);
    });

    it('test_file_save_artifact_skips_abandoned_reservation', async () => {
      const versionsDir = path.join(
        sessionArtifactDir(root, 'app', 'user', 'session', 'report.txt'),
        'versions',
      );
      await fs.mkdir(path.join(versionsDir, '.0.pending'), {recursive: true});

      const version = await service.saveArtifact({
        ...scope,
        artifact: {text: 'complete'},
      });

      expect(version).toBe(1);
      expect(await service.listVersions(scope)).toEqual([1]);
      // The abandoned reservation holds version 0 permanently; it is skipped,
      // not reclaimed.
      expect(
        (await fs.stat(path.join(versionsDir, '.0.pending'))).isDirectory(),
      ).toBe(true);
    });

    it('test_file_save_artifact_never_republishes_existing_version', async () => {
      // Python patches the module-private version scan to return a stale empty
      // list. adk-js has no such seam, and adding one only for the test is not
      // worth a production hook, so the same state is built on disk: an entry
      // at `versions/0` that the scan skips because it is not a directory. The
      // reservation must step over it instead of publishing onto it.
      const versionsDir = path.join(
        sessionArtifactDir(root, 'app', 'user', 'session', 'report.txt'),
        'versions',
      );
      await fs.mkdir(versionsDir, {recursive: true});
      await fs.writeFile(path.join(versionsDir, '0'), 'occupied', 'utf-8');

      const version = await service.saveArtifact({
        ...scope,
        artifact: {text: 'second'},
      });

      expect(version).toBe(1);
      expect(await fs.readFile(path.join(versionsDir, '0'), 'utf-8')).toBe(
        'occupied',
      );
      expect((await service.loadArtifact({...scope, version: 1}))?.text).toBe(
        'second',
      );
      expect(await findPendingDirs(root)).toEqual([]);
    });
  });

  describe('out-of-scope filenames', () => {
    const outOfScopeFilenames = [
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

    for (const filename of outOfScopeFilenames) {
      it(`test_file_save_artifact_rejects_out_of_scope_paths (${filename})`, async () => {
        await expect(
          service.saveArtifact({
            appName: 'myapp',
            userId: 'user123',
            sessionId: 'sess123',
            filename,
            artifact: {text: 'content'},
          }),
        ).rejects.toThrow(InputValidationError);
      });
    }

    it('test_file_save_artifact_rejects_absolute_path_within_scope', async () => {
      const absoluteInScope = path.join(
        sessionArtifactDir(root, 'myapp', 'user123', 'sess123', 'diagram.png'),
      );

      await expect(
        service.saveArtifact({
          appName: 'myapp',
          userId: 'user123',
          sessionId: 'sess123',
          filename: absoluteInScope,
          artifact: {text: 'content'},
        }),
      ).rejects.toThrow(InputValidationError);
    });
  });

  describe('app name validation', () => {
    // adk-python asserts on its deny-list wording. adk-js keeps its stricter
    // allow-list, so these assert the rejection and adk-js's own message.
    const invalidAppNames = [
      '../escape',
      '../../etc',
      'foo/../../bar',
      '..',
      '.',
      'null\x00byte',
      '',
      '/etc/passwd',
      '\\leading\\backslash',
      'C:\\absolute',
      'C:drive-relative',
    ];
    const scope = {
      userId: 'user123',
      sessionId: 'sess123',
      filename: 'user:safe.txt',
    };

    for (const appName of invalidAppNames) {
      it(`test_save_artifact_rejects_traversal_in_app_name (${JSON.stringify(appName)})`, async () => {
        await expect(
          service.saveArtifact({
            ...scope,
            appName,
            artifact: {text: 'data'},
          }),
        ).rejects.toThrow('Invalid appName');
      });
    }

    it('test_load_artifact_rejects_traversal_in_app_name', async () => {
      await expect(
        service.loadArtifact({...scope, appName: '../escape'}),
      ).rejects.toThrow('Invalid appName');
    });

    it('test_delete_artifact_rejects_traversal_in_app_name', async () => {
      await expect(
        service.deleteArtifact({...scope, appName: '../escape'}),
      ).rejects.toThrow('Invalid appName');
    });

    it('test_list_artifact_keys_rejects_traversal_in_app_name', async () => {
      await expect(
        service.listArtifactKeys({
          appName: '../escape',
          userId: 'user123',
          sessionId: 'sess123',
        }),
      ).rejects.toThrow('Invalid appName');
    });
  });

  it('test_load_artifact_preserves_inline_data_display_name', async () => {
    const scope = {
      appName: 'app0',
      userId: 'user0',
      sessionId: 'sess0',
      filename: 'artifact.bin',
    };
    const displayName = 'My Report (final).png';
    await service.saveArtifact({
      ...scope,
      artifact: {
        inlineData: {
          mimeType: 'image/png',
          data: Buffer.from('\x89PNG\r\n\x1a\n', 'binary').toString('base64'),
          displayName,
        },
      },
    });

    const loaded = await service.loadArtifact(scope);
    expect(loaded?.inlineData?.displayName).toBe(displayName);
  });

  describe('canonical URI', () => {
    it('test_load_artifact_ignores_canonical_uri_from_metadata', async () => {
      const secret = path.join(root, 'secret.txt');
      await fs.writeFile(secret, 'TOP-SECRET', 'utf-8');
      // The payload is deliberately absent. That is the state the delete/load
      // race produced, and it is what previously fell through to canonicalUri.
      await writeTamperedMetadata(
        root,
        'poisoned.txt',
        pathToFileURL(secret).toString(),
      );

      const loaded = await service.loadArtifact({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'poisoned.txt',
      });

      expect(loaded).toBeUndefined();
    });

    it('test_get_artifact_version_ignores_canonical_uri_from_metadata', async () => {
      await writeTamperedMetadata(root, 'poisoned.txt', 'file:///etc/passwd');

      const artifactVersion = await service.getArtifactVersion({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'poisoned.txt',
        version: 0,
      });

      expect(artifactVersion).toBeDefined();
      expect(artifactVersion?.canonicalUri).not.toBe('file:///etc/passwd');
      expect(artifactVersion?.canonicalUri).toMatch(
        new RegExp(`^${pathToFileURL(root).toString()}/`),
      );
    });
  });

  describe('reserved metadata filename', () => {
    const reservedFilenames = [
      'metadata.json',
      'nested/metadata.json',
      'user:metadata.json',
      // Case variants: on a case-insensitive filesystem these resolve to the
      // metadata document too, so the name is rejected caselessly.
      'Metadata.json',
      'METADATA.JSON',
      'nested/MetaData.Json',
    ];

    for (const filename of reservedFilenames) {
      it(`test_save_artifact_rejects_reserved_metadata_filename (${filename})`, async () => {
        await expect(
          service.saveArtifact({
            appName: 'app',
            userId: 'user',
            sessionId: 'session',
            filename,
            artifact: {text: 'payload'},
          }),
        ).rejects.toThrow(InputValidationError);
      });
    }

    it('test_reserved_metadata_filename_stays_deletable', async () => {
      // The rejection lives on the save path rather than in the directory
      // helper, which reads and deletes share. An artifact stored under this
      // name before it was reserved would otherwise be stranded.
      const artifactDir = sessionArtifactDir(
        root,
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
      await service.loadArtifact(scope);
      await service.deleteArtifact(scope);

      await expect(fs.stat(artifactDir)).rejects.toThrow();
    });
  });

  describe('metadata document', () => {
    it.skipIf(process.platform === 'win32')(
      'test_metadata_and_payload_share_permissions',
      async () => {
        await service.saveArtifact({
          appName: 'app',
          userId: 'user',
          sessionId: 'session',
          filename: 'report.txt',
          artifact: {text: 'payload'},
        });
        const versionDir = path.join(
          sessionArtifactDir(root, 'app', 'user', 'session', 'report.txt'),
          'versions',
          '0',
        );

        expect(await fileMode(path.join(versionDir, 'metadata.json'))).toBe(
          await fileMode(path.join(versionDir, 'report.txt')),
        );
      },
    );

    it('test_file_metadata_camelcase', async () => {
      await service.saveArtifact({
        appName: 'myapp',
        userId: 'user123',
        sessionId: 'sess789',
        filename: 'docs/report.txt',
        artifact: {
          inlineData: {
            mimeType: 'application/octet-stream',
            data: Buffer.from('binary-content').toString('base64'),
          },
        },
      });

      const versionDir = path.join(
        sessionArtifactDir(root, 'myapp', 'user123', 'sess789', 'docs'),
        'report.txt',
        'versions',
        '0',
      );
      const metadataPath = path.join(versionDir, 'metadata.json');
      const rawMetadata = await fs.readFile(metadataPath, 'utf-8');
      expect(rawMetadata).not.toContain('\n');

      const payloadPath = path.join(versionDir, 'report.txt');
      // adk-python also persists `createTime`; adk-js has no such field on
      // `ArtifactVersion`, so it is absent here.
      expect(JSON.parse(rawMetadata)).toEqual({
        fileName: 'docs/report.txt',
        mimeType: 'application/octet-stream',
        canonicalUri: pathToFileURL(payloadPath).toString(),
        version: 0,
        customMetadata: {},
      });
      expect(await fs.readFile(payloadPath, 'utf-8')).toBe('binary-content');
    });

    it('test_file_list_artifact_versions', async () => {
      const scope = {
        appName: 'myapp',
        userId: 'user123',
        sessionId: 'sess789',
        filename: 'docs/report.txt',
      };
      const customMetadata = {origin: 'unit-test'};
      await service.saveArtifact({
        ...scope,
        artifact: {
          inlineData: {
            mimeType: 'application/octet-stream',
            data: Buffer.from('binary-content').toString('base64'),
          },
        },
        customMetadata,
      });

      const versions = await service.listArtifactVersions(scope);
      expect(versions).toHaveLength(1);
      const payloadPath = path.join(
        sessionArtifactDir(root, 'myapp', 'user123', 'sess789', 'docs'),
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
      expect(
        await fs.readFile(fileURLToPath(versions[0].canonicalUri!), 'utf-8'),
      ).toBe('binary-content');

      const fetched = await service.getArtifactVersion({...scope, version: 0});
      expect(fetched).toEqual(versions[0]);

      const latest = await service.getArtifactVersion(scope);
      expect(latest).toEqual(versions[0]);
    });
  });

  describe('inline data validation', () => {
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

    it('test_save_artifact_discards_version_when_metadata_write_fails', async () => {
      const scope = {
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'report.txt',
      };
      await service.saveArtifact({...scope, artifact: {text: 'v0'}});

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(
        service.saveArtifact({
          ...scope,
          artifact: {text: 'poison'},
          customMetadata: circular,
        }),
      ).rejects.toThrow(TypeError);

      // The failed version is discarded entirely and the previous one intact.
      expect(await service.listVersions(scope)).toEqual([0]);
      expect((await service.loadArtifact(scope))?.text).toBe('v0');
      expect(await findPendingDirs(root)).toEqual([]);
    });
  });

  it('test_list_artifact_keys_survives_metadata_path_shadowed_by_dir', async () => {
    // Creates `<user scope>/a/versions/0/metadata.json` as a *directory*,
    // which made every subsequent listing for this user fail.
    await service.saveArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'session',
      filename: 'user:a/versions/0/metadata.json/payload.txt',
      artifact: {text: 'x'},
    });

    const keys = await service.listArtifactKeys({
      appName: 'app',
      userId: 'user',
      sessionId: 'session',
    });

    // The shadowed artifact has no readable metadata, so it is listed by its
    // scope-relative path rather than dropped or raised on.
    expect(keys).toEqual(['user:a']);
  });
});
