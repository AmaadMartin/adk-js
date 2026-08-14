/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {LlmAgent} from '../../../src/agents/llm_agent.js';
import {InMemoryArtifactService} from '../../../src/artifacts/in_memory_artifact_service.js';
import {ScopedArtifactService} from '../../../src/artifacts/scoped_artifact_service.js';
import type {SessionArtifactService} from '../../../src/artifacts/session_artifact_service.js';
import type {
  CodeExecutionResult,
  File,
} from '../../../src/code_executors/code_execution_utils.js';
import {FileContentEncoding} from '../../../src/code_executors/code_execution_utils.js';
import {PluginManager} from '../../../src/plugins/plugin_manager.js';
import {createSession} from '../../../src/sessions/session.js';
import {
  materializeScriptOutputs,
  saveScriptOutputs,
} from '../../../src/tools/skill/script_output_utils.js';
import {logger} from '../../../src/utils/logger.js';

/**
 * Environment variables `os.tmpdir()` consults, so a test can give the
 * implementation a temp root it exclusively owns and observe exactly what was
 * created in it. POSIX reads TMPDIR; Windows reads TEMP then TMP.
 */
const TMPDIR_ENV_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const;

function createSessionArtifactService(): SessionArtifactService {
  return new ScopedArtifactService(
    new InMemoryArtifactService(),
    'test-app',
    'test-user',
    'test-session',
  );
}

function createContext(artifactService?: SessionArtifactService): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
      artifactService,
    }),
  });
}

function textFile(name: string, content: string): File {
  return {
    name,
    content,
    contentEncoding: FileContentEncoding.UTF8,
    mimeType: 'text/plain',
  };
}

function executionResult(outputFiles: File[]): CodeExecutionResult {
  return {stdout: 'out', stderr: 'err', outputFiles};
}

/** Reads back the base64 payload an artifact was saved with. */
async function loadInlineData(
  artifactService: SessionArtifactService,
  filename: string,
): Promise<string> {
  const artifact = await artifactService.loadArtifact({filename});
  const data = artifact?.inlineData?.data;
  if (data === undefined) {
    expect.fail(`Artifact '${filename}' has no inline data.`);
  }
  return data;
}

describe('materializeScriptOutputs', () => {
  let tmpRoot: string;
  let outputDir: string;
  let originalTmpdirEnv: Array<string | undefined>;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'script_output_test_'));
    // Real temp root is captured above, then redirected so the unconfigured
    // path writes somewhere this test can enumerate and delete.
    originalTmpdirEnv = TMPDIR_ENV_VARS.map((name) => process.env[name]);
    for (const name of TMPDIR_ENV_VARS) {
      process.env[name] = tmpRoot;
    }
    outputDir = await fs.mkdtemp(path.join(tmpRoot, 'configured_'));
  });

  afterEach(async () => {
    TMPDIR_ENV_VARS.forEach((name, index) => {
      const original = originalTmpdirEnv[index];
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    });
    await fs.rm(tmpRoot, {recursive: true, force: true});
  });

  it('writes output files into an explicit output directory', async () => {
    const result = await materializeScriptOutputs(
      executionResult([textFile('report.txt', 'contents')]),
      outputDir,
    );

    expect(result.outputDir).toBe(outputDir);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.outputFiles.map((file) => file.name)).toEqual(['report.txt']);
    expect(await fs.readFile(path.join(outputDir, 'report.txt'), 'utf8')).toBe(
      'contents',
    );
  });

  it('resolves a relative output directory against the working directory', async () => {
    // Working directory is moved to the temp root rather than deriving a
    // relative path from the real one: on Windows they sit on different
    // drives, where no relative path between them exists.
    const originalCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const relativeDir = path.basename(outputDir);
      expect(path.isAbsolute(relativeDir)).toBe(false);
      const expectedDir = path.resolve(process.cwd(), relativeDir);

      const result = await materializeScriptOutputs(
        executionResult([textFile('relative.txt', 'contents')]),
        relativeDir,
      );

      expect(result.outputDir).toBe(expectedDir);
      expect(
        await fs.readFile(path.join(expectedDir, 'relative.txt'), 'utf8'),
      ).toBe('contents');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('writes to a fresh temp directory when no output directory is configured', async () => {
    const name = 'unconfigured_default_output.txt';

    const result = await materializeScriptOutputs(
      executionResult([textFile(name, 'contents')]),
    );

    if (!result.outputDir) {
      expect.fail('expected an outputDir on the result');
    }
    expect(path.dirname(result.outputDir)).toBe(tmpRoot);
    expect(result.outputDir).not.toBe(process.cwd());
    expect(await fs.readFile(path.join(result.outputDir, name), 'utf8')).toBe(
      'contents',
    );
    await expect(fs.access(path.join(process.cwd(), name))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('creates a distinct directory per call', async () => {
    const first = await materializeScriptOutputs(
      executionResult([textFile('a.txt', 'first')]),
    );
    const second = await materializeScriptOutputs(
      executionResult([textFile('a.txt', 'second')]),
    );

    if (!first.outputDir || !second.outputDir) {
      expect.fail('expected an outputDir on both results');
    }
    expect(first.outputDir).not.toBe(second.outputDir);
    expect(await fs.readFile(path.join(first.outputDir, 'a.txt'), 'utf8')).toBe(
      'first',
    );
    expect(
      await fs.readFile(path.join(second.outputDir, 'a.txt'), 'utf8'),
    ).toBe('second');
  });

  it('returns the result unchanged and creates nothing when there are no output files', async () => {
    const before = await fs.readdir(tmpRoot);
    const input = executionResult([]);

    const result = await materializeScriptOutputs(input);

    expect(result).toBe(input);
    expect(result.outputDir).toBeUndefined();
    expect(await fs.readdir(tmpRoot)).toEqual(before);
  });

  it('rejects an output file that escapes the configured directory', async () => {
    await expect(
      materializeScriptOutputs(
        executionResult([textFile(path.join('..', 'escape.txt'), 'nope')]),
        outputDir,
      ),
    ).rejects.toThrow(/Path traversal detected/);

    await expect(
      fs.access(path.resolve(outputDir, '..', 'escape.txt')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('appends a numeric suffix on collision within the configured directory', async () => {
    await fs.writeFile(path.join(outputDir, 'notes.txt'), 'existing');

    const result = await materializeScriptOutputs(
      executionResult([textFile('notes.txt', 'fresh')]),
      outputDir,
    );

    expect(result.outputFiles.map((file) => file.name)).toEqual([
      'notes_2.txt',
    ]);
    expect(await fs.readFile(path.join(outputDir, 'notes.txt'), 'utf8')).toBe(
      'existing',
    );
    expect(await fs.readFile(path.join(outputDir, 'notes_2.txt'), 'utf8')).toBe(
      'fresh',
    );
  });
});

describe('saveScriptOutputs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty file list and saves nothing when the script produced no files', async () => {
    const artifactService = createSessionArtifactService();
    const toolContext = createContext(artifactService);

    const response = await saveScriptOutputs(toolContext, {
      stdout: 'done',
      stderr: '',
      outputFiles: [],
    });

    expect(response).toEqual({stdout: 'done', stderr: '', outputFiles: []});
    expect(await artifactService.listArtifactKeys()).toEqual([]);
    expect(toolContext.actions.artifactDelta).toEqual({});
  });

  it('does not warn about a missing artifact service when the script produced no files', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const response = await saveScriptOutputs(createContext(), {
      stdout: 'done',
      stderr: '',
      outputFiles: [],
    });

    expect(response).toEqual({stdout: 'done', stderr: '', outputFiles: []});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('saves each output file to the artifact service and returns only names and mime types', async () => {
    const artifactService = createSessionArtifactService();
    const toolContext = createContext(artifactService);

    const response = await saveScriptOutputs(toolContext, {
      stdout: 'script stdout',
      stderr: 'script stderr',
      outputFiles: [
        textFile('report.csv', 'a,b'),
        {
          name: 'chart.png',
          content: 'AAEC',
          contentEncoding: FileContentEncoding.BASE64,
          mimeType: 'image/png',
        },
      ],
    });

    expect(response).toEqual({
      stdout: 'script stdout',
      stderr: 'script stderr',
      outputFiles: [
        {name: 'report.csv', mimeType: 'text/plain'},
        {name: 'chart.png', mimeType: 'image/png'},
      ],
    });
    // The model must never receive the file bytes.
    expect(Object.keys(response.outputFiles[0])).toEqual(['name', 'mimeType']);
    expect((await artifactService.listArtifactKeys()).sort()).toEqual([
      'chart.png',
      'report.csv',
    ]);
  });

  it('base64-encodes utf-8 file content before saving', async () => {
    const artifactService = createSessionArtifactService();
    const toolContext = createContext(artifactService);

    await saveScriptOutputs(toolContext, {
      stdout: '',
      stderr: '',
      outputFiles: [textFile('out.txt', 'hello')],
    });

    expect(await loadInlineData(artifactService, 'out.txt')).toBe(
      Buffer.from('hello', 'utf-8').toString('base64'),
    );
  });

  it('passes base64 file content through unchanged', async () => {
    const artifactService = createSessionArtifactService();
    const toolContext = createContext(artifactService);

    await saveScriptOutputs(toolContext, {
      stdout: '',
      stderr: '',
      outputFiles: [
        {
          name: 'out.bin',
          content: 'aGVsbG8=',
          contentEncoding: FileContentEncoding.BASE64,
          mimeType: 'application/octet-stream',
        },
      ],
    });

    expect(await loadInlineData(artifactService, 'out.bin')).toBe('aGVsbG8=');
  });

  it('treats content with no declared encoding as base64', async () => {
    const artifactService = createSessionArtifactService();
    const toolContext = createContext(artifactService);

    await saveScriptOutputs(toolContext, {
      stdout: '',
      stderr: '',
      outputFiles: [
        {name: 'out.png', content: 'aGVsbG8=', mimeType: 'image/png'},
      ],
    });

    expect(await loadInlineData(artifactService, 'out.png')).toBe('aGVsbG8=');
  });

  it('records an artifact delta for each saved file', async () => {
    const artifactService = createSessionArtifactService();
    const toolContext = createContext(artifactService);

    await saveScriptOutputs(toolContext, {
      stdout: '',
      stderr: '',
      outputFiles: [textFile('a.txt', 'a'), textFile('b.txt', 'b')],
    });

    expect(toolContext.actions.artifactDelta).toEqual({
      'a.txt': 0,
      'b.txt': 0,
    });
  });

  it('saves a repeated filename as a new artifact version', async () => {
    const artifactService = createSessionArtifactService();

    await saveScriptOutputs(createContext(artifactService), {
      stdout: '',
      stderr: '',
      outputFiles: [textFile('report.csv', 'first')],
    });
    const secondContext = createContext(artifactService);
    const response = await saveScriptOutputs(secondContext, {
      stdout: '',
      stderr: '',
      outputFiles: [textFile('report.csv', 'second')],
    });

    expect(response.outputFiles).toEqual([
      {name: 'report.csv', mimeType: 'text/plain'},
    ]);
    expect(secondContext.actions.artifactDelta).toEqual({'report.csv': 1});
    expect(await artifactService.listVersions('report.csv')).toEqual([0, 1]);
  });

  it('reports produced files with a warning when no artifact service is configured', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const toolContext = createContext();

    const response = await saveScriptOutputs(toolContext, {
      stdout: 'script stdout',
      stderr: 'script stderr',
      outputFiles: [textFile('out.txt', 'hello')],
    });

    expect(response).toEqual({
      stdout: 'script stdout',
      stderr: 'script stderr',
      outputFiles: [{name: 'out.txt', mimeType: 'text/plain'}],
      warning:
        'No artifact service is configured; 1 output file(s) produced by the ' +
        'script were not saved to the session.',
    });
    expect(warnSpy).toHaveBeenCalledWith(response.warning);
  });

  it('returns the saved subset with a warning when an artifact save fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const artifactService = createSessionArtifactService();
    const reason = new Error('artifact backend unavailable');
    const save = artifactService.saveArtifact.bind(artifactService);
    vi.spyOn(artifactService, 'saveArtifact').mockImplementation((request) =>
      request.filename === 'b.txt' ? Promise.reject(reason) : save(request),
    );
    const toolContext = createContext(artifactService);

    const response = await saveScriptOutputs(toolContext, {
      stdout: 'script stdout',
      stderr: 'script stderr',
      outputFiles: [
        textFile('a.txt', 'a'),
        textFile('b.txt', 'b'),
        textFile('c.txt', 'c'),
      ],
    });

    expect(response).toEqual({
      stdout: 'script stdout',
      stderr: 'script stderr',
      outputFiles: [
        {name: 'a.txt', mimeType: 'text/plain'},
        {name: 'c.txt', mimeType: 'text/plain'},
      ],
      warning:
        'Failed to save 1 of 3 output file(s) to the artifact service: b.txt.',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to save output file 'b.txt' to the artifact service.",
      reason,
    );
    expect(toolContext.actions.artifactDelta).toEqual({'a.txt': 0, 'c.txt': 0});
  });
});
