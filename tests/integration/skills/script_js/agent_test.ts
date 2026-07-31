/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {exec, spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {normalizeLineEndings, sendInput} from '../../test_case_utils.js';

const execAsync = promisify(exec);
const dirname = process.cwd();
const PROJECT_PATH = `${dirname}/tests/integration/skills/script_js`;
const TEST_EXECUTION_TIMEOUT = 60000;
const GENERATED_FILES = [
  'ephemeral_entanglement.md',
  'index.html',
  'sketch.js',
];

/** Directory backing the CLI's file artifact service for this run. */
let artifactRoot: string;

/**
 * Returns the content of a stored artifact, searched by filename anywhere
 * under the artifact root so the test does not depend on the storage layout.
 */
async function findArtifact(
  dir: string,
  name: string,
): Promise<string | undefined> {
  for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findArtifact(full, name);
      if (found !== undefined) {
        return found;
      }
    } else if (entry.name === name) {
      return fs.readFile(full, 'utf-8');
    }
  }
  return undefined;
}

async function readArtifact(name: string): Promise<string> {
  const content = await findArtifact(artifactRoot, name);
  if (content === undefined) {
    expect.fail(`Artifact '${name}' was not saved to the artifact service.`);
  }
  return content;
}

/**
 * This integration test verifies that an agent equipped with script execution skills
 * can successfully process a request to create algorithmic art.
 *
 * Specifically, it:
 * 1. Starts the agent by running `npm run start` in the test project directory.
 * 2. Simulates user interaction by sending a prompt: "Let's create algorithmic art."
 * 3. Asserts that the agent's response matches the expected output, confirming it claims to have created the art and files.
 * 4. Verifies that the expected files (`ephemeral_entanglement.md`, `index.html`, `sketch.js`) were saved to the artifact service, and that none of them was written into the directory the agent process was started from.
 * 5. Compares the content of these saved artifacts with reference files in the `expected/` directory to ensure correctness.
 * 6. Cleans up the artifact store and installed dependencies after execution.
 *
 * This test ensures the end-to-end flow of an agent using tools to generate files based on a high-level request and persist them where the session can reach them.
 */
describe('Agent with skills that generates JS script and runs it locally', () => {
  beforeAll(async () => {
    artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-'));
    await execAsync('npm install', {cwd: PROJECT_PATH});
  }, TEST_EXECUTION_TIMEOUT);

  it(
    'should run agent with skills successfully',
    async () => {
      // getArtifactServiceFromUri strips the scheme with a plain string split,
      // so the path has to follow `file://` directly: a Windows drive letter
      // does not survive the leading slash of a canonical `file:///` URL.
      const artifactServiceUri = `file://${artifactRoot.split(path.sep).join('/')}`;
      const childProcess = spawn(
        'npm',
        ['run', 'start', '--', '--artifact_service_uri', artifactServiceUri],
        {
          cwd: PROJECT_PATH,
          shell: true,
        },
      );

      const response = await sendInput(
        childProcess,
        'Let`s create algorithmic art.\n',
      );
      expect(response.toString()).toContain(
        'I have created an original algorithmic art piece titled **"Ephemeral Entanglement"**.\n\nFollowing the generative art movement philosophy, I\'ve generated three files for you:\n\n1.  **`ephemeral_entanglement.md`**: The algorithmic philosophy detailing the conceptual foundation of this piece. It explores the delicate dance between deterministic forces and stochastic drift, visualizing unseen connections in a dynamic system.\n2.  **`index.html`**: The interactive viewer for the generative art. It includes a user interface to adjust parameters like particle count, connection radius, and noise scale, allowing you to explore the algorithm\'s emergent behavior.\n3.  **`sketch.js`**: The meticulously crafted p5.js algorithm that brings the philosophy to life. It uses layered Perlin noise to drive a flow field, guiding particles that form ephemeral, glowing bonds when they come into proximity. \n\nYou can view the art by opening the `index.html` file in your web browser. Let the algorithmic dance begin!',
      );

      // Shut the CLI down so the session's artifacts are fully flushed.
      await sendInput(childProcess, 'exit\n');

      // The script's output belongs to the session, not to the directory the
      // agent process happens to be running in.
      for (const name of GENERATED_FILES) {
        await expect(fs.access(`${PROJECT_PATH}/${name}`)).rejects.toThrow(
          /ENOENT/,
        );
      }

      // verify that the artifacts were saved and have the expected content
      const resultMdFile = await readArtifact('ephemeral_entanglement.md');
      const resultScriptFile = await readArtifact('sketch.js');
      const resultHtmlFile = await readArtifact('index.html');

      const expectedMdFile = await fs.readFile(
        `${PROJECT_PATH}/expected/ephemeral_entanglement.md`,
        'utf-8',
      );
      const expectedScriptFile = await fs.readFile(
        `${PROJECT_PATH}/expected/sketch.js`,
        'utf-8',
      );
      const expectedHtmlFile = await fs.readFile(
        `${PROJECT_PATH}/expected/index.html`,
        'utf-8',
      );

      expect((normalizeLineEndings(resultMdFile) as string).trim()).toEqual(
        (normalizeLineEndings(expectedMdFile) as string).trim(),
      );
      expect((normalizeLineEndings(resultScriptFile) as string).trim()).toEqual(
        (normalizeLineEndings(expectedScriptFile) as string).trim(),
      );
      expect((normalizeLineEndings(resultHtmlFile) as string).trim()).toEqual(
        (normalizeLineEndings(expectedHtmlFile) as string).trim(),
      );
    },
    TEST_EXECUTION_TIMEOUT,
  );

  afterAll(async () => {
    await fs.rm(artifactRoot, {recursive: true, force: true}).catch(() => {});

    await fs
      .rm(`${PROJECT_PATH}/node_modules`, {recursive: true, force: true})
      .catch(() => {});
    await fs.unlink(`${PROJECT_PATH}/package-lock.json`).catch(() => {});
  });
});
