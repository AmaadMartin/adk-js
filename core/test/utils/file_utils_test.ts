/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FileContentEncoding} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {getMimeTypeAndEncoding} from '../../src/utils/file_extension_utils.js';
import {
  guessMimeType,
  materializeFiles,
  validatePathSegment,
} from '../../src/utils/file_utils.js';

describe('file_utils', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file_utils_test_'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  describe('materializeFiles', () => {
    it('should materialize files within the target directory', async () => {
      const files = [
        {
          name: 'test.txt',
          content: 'hello',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
        {
          name: 'sub/test2.txt',
          content: 'world',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await materializeFiles(files, tempDir);

      const content1 = await fs.readFile(
        path.join(tempDir, 'test.txt'),
        'utf8',
      );
      expect(content1).toBe('hello');

      const content2 = await fs.readFile(
        path.join(tempDir, 'sub/test2.txt'),
        'utf8',
      );
      expect(content2).toBe('world');
    });

    it('should throw an error if file attempts to escape target directory via relative path', async () => {
      const files = [
        {
          name: '../escape.txt',
          content: 'dangerous',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await expect(materializeFiles(files, tempDir)).rejects.toThrow(
        /Path traversal detected/,
      );
    });

    it('should throw an error if file attempts to escape into a sibling directory sharing a name prefix', async () => {
      // A plain `resolvedPath.startsWith(resolvedBaseDir)` check is fooled by a
      // sibling directory whose name merely starts with the same string as the
      // target directory (e.g. target `.../sandbox` vs sibling
      // `.../sandbox-evil`), since it never requires a path-separator boundary.
      const siblingName = `${path.basename(tempDir)}-evil`;
      const files = [
        {
          name: `../${siblingName}/escape.txt`,
          content: 'dangerous',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await expect(materializeFiles(files, tempDir)).rejects.toThrow(
        /Path traversal detected/,
      );

      const siblingPath = path.join(path.dirname(tempDir), siblingName);
      await expect(fs.access(siblingPath)).rejects.toThrow();
    });

    it('should throw an error if file attempts to escape target directory via absolute path', async () => {
      const outsidePath = path.resolve(tempDir, '../outside.txt');
      const files = [
        {
          name: outsidePath,
          content: 'dangerous',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await expect(materializeFiles(files, tempDir)).rejects.toThrow(
        /Path traversal detected/,
      );
    });

    it('should allow relative paths that stay within the target directory', async () => {
      const files = [
        {
          name: './test.txt',
          content: 'hello',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
        {
          name: 'sub/../test2.txt',
          content: 'world',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await materializeFiles(files, tempDir);

      const content1 = await fs.readFile(
        path.join(tempDir, 'test.txt'),
        'utf8',
      );
      expect(content1).toBe('hello');

      const content2 = await fs.readFile(
        path.join(tempDir, 'test2.txt'),
        'utf8',
      );
      expect(content2).toBe('world');
    });

    it('rejects a sibling directory whose name extends the base directory name', async () => {
      const base = path.join(tempDir, 'out');
      const files = [
        {
          name: path.join('..', 'outX', 'leak.txt'),
          content: 'dangerous',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await expect(materializeFiles(files, base)).rejects.toThrow(
        /Path traversal detected/,
      );

      await expect(
        fs.access(path.join(tempDir, 'outX', 'leak.txt')),
      ).rejects.toThrow(/ENOENT/);
    });

    it("allows a nested path whose segment merely starts with '..'", async () => {
      const files = [
        {
          name: path.join('..data', 'report.txt'),
          content: 'contained',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await materializeFiles(files, tempDir);

      const content = await fs.readFile(
        path.join(tempDir, '..data', 'report.txt'),
        'utf8',
      );
      expect(content).toBe('contained');
    });

    it('should append a numeric suffix to the filename if it already exists', async () => {
      const files = [
        {
          name: 'collision.txt',
          content: 'first',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
        {
          name: 'collision.txt',
          content: 'second',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
        {
          name: 'collision.txt',
          content: 'third',
          contentEncoding: FileContentEncoding.UTF8,
          mimeType: 'text/plain',
        },
      ];

      await materializeFiles(files, tempDir);

      const content1 = await fs.readFile(
        path.join(tempDir, 'collision.txt'),
        'utf8',
      );
      expect(content1).toBe('first');

      const content2 = await fs.readFile(
        path.join(tempDir, 'collision_2.txt'),
        'utf8',
      );
      expect(content2).toBe('second');

      const content3 = await fs.readFile(
        path.join(tempDir, 'collision_3.txt'),
        'utf8',
      );
      expect(content3).toBe('third');
    });
  });
  describe.each(['appName', 'userId', 'sessionId'])(
    'validatePathSegment %s',
    (fieldName) => {
      it.each([
        'user123',
        'myapp',
        'sess123',
        'group/user123',
        'has/slash',
        'back\\slash',
        'user:profile.txt',
        'a/./b',
        '1:x',
        '_:x',
        'é:x',
        ':x',
        'plain',
      ])('accepts %s', (value) => {
        expect(() => validatePathSegment(value, fieldName)).not.toThrow();
      });

      it.each([
        '../escape',
        '../../etc',
        'foo/../../bar',
        'mixed/..\\separators',
        './..\\',
        '.\\../',
        '..',
        '.',
        '',
        '/etc/passwd',
        '/leading/slash',
        '\\leading\\backslash',
        'C:\\absolute',
        'C:/absolute',
        'C:drive-relative',
        'C:',
        'c:/data',
        'Z:relative',
      ])('rejects %s', (value) => {
        expect(() => validatePathSegment(value, fieldName)).toThrow();
      });

      it('rejects a value holding a null byte', () => {
        expect(() => validatePathSegment('null\x00byte', fieldName)).toThrow(
          `${fieldName} must not contain null bytes.`,
        );
      });
    },
  );

  describe('validatePathSegment rejection messages', () => {
    it('reports an empty value', () => {
      expect(() => validatePathSegment('', 'userId')).toThrow(
        'userId must not be empty.',
      );
    });

    it('reports a leading slash before a traversal segment', () => {
      expect(() => validatePathSegment('/../etc', 'appName')).toThrow(
        "appName '/../etc' must not be an absolute path or start with a slash.",
      );
    });

    it('reports a drive letter before a traversal segment', () => {
      expect(() => validatePathSegment('C:/../etc', 'sessionId')).toThrow(
        "sessionId 'C:/../etc' must not be drive-qualified.",
      );
    });

    it('reports a traversal segment', () => {
      expect(() => validatePathSegment('foo/../bar', 'sessionId')).toThrow(
        "sessionId 'foo/../bar' must not contain traversal segments.",
      );
    });
  });
});

/** Every extension the consolidated MIME table knows. */
const ALL_MIME_TABLE_EXTENSIONS = [
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.cts',
  '.mts',
  '.py',
  '.sh',
  '.bash',
  '.md',
  '.txt',
  '.html',
  '.css',
  '.json',
  '.csv',
  '.svg',
  '.xml',
  '.yaml',
  '.yml',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.pdf',
];

describe('guessMimeType', () => {
  describe('extensions gained from the consolidated table', () => {
    it.each([
      ['README.md', 'text/markdown'],
      ['notes.txt', 'text/plain'],
      ['page.html', 'text/html'],
      ['style.css', 'text/css'],
      ['icon.svg', 'image/svg+xml'],
      ['config.yaml', 'text/yaml'],
      ['config.yml', 'text/yaml'],
    ])('resolves %s', (filePath, expectedMime) => {
      expect(guessMimeType(filePath)).toBe(expectedMime);
    });
  });

  describe('extensions the consolidation must not lose', () => {
    it.each([
      ['doc.pdf', 'application/pdf'],
      ['photo.jpg', 'image/jpeg'],
      ['photo.jpeg', 'image/jpeg'],
      ['photo.png', 'image/png'],
      ['anim.gif', 'image/gif'],
      ['data.csv', 'text/csv'],
      ['data.json', 'application/json'],
      ['data.xml', 'application/xml'],
      ['deploy.sh', 'text/x-shellscript'],
      ['deploy.bash', 'text/x-shellscript'],
      ['main.py', 'text/x-python'],
      ['main.js', 'text/javascript'],
      ['main.cjs', 'text/javascript'],
      ['main.mjs', 'text/javascript'],
      ['main.ts', 'text/javascript'],
      ['main.cts', 'text/javascript'],
      ['main.mts', 'text/javascript'],
    ])('still resolves %s', (filePath, expectedMime) => {
      expect(guessMimeType(filePath)).toBe(expectedMime);
    });
  });

  describe('path and case handling', () => {
    it('reads the extension of a nested path', () => {
      expect(guessMimeType('a/b/c/helper.py')).toBe('text/x-python');
    });

    it('ignores extension case', () => {
      expect(guessMimeType('IMG.PNG')).toBe('image/png');
    });

    it('uses only the last extension of a double extension', () => {
      expect(guessMimeType('archive.tar.gz')).toBe('application/octet-stream');
    });
  });

  describe('names without an extension', () => {
    it('falls back for a bare name', () => {
      expect(guessMimeType('output_file')).toBe('application/octet-stream');
    });

    it('falls back for a dotfile', () => {
      expect(guessMimeType('.gitignore')).toBe('application/octet-stream');
    });

    it('falls back for a bare name that spells an extension', () => {
      // 'png' is the whole file name here, so the file has no extension.
      expect(guessMimeType('png')).toBe('application/octet-stream');
    });
  });

  it('agrees with getMimeTypeAndEncoding on every known extension', () => {
    for (const ext of ALL_MIME_TABLE_EXTENSIONS) {
      expect(guessMimeType(`file${ext}`)).toBe(
        getMimeTypeAndEncoding(ext).mimeType,
      );
    }
  });
});
