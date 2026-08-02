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

/**
 * This integration test verifies that an agent equipped with script execution skills
 * can successfully process a request to create algorithmic art.
 *
 * Specifically, it:
 * 1. Starts the agent by running `npm run start` in the test project directory.
 * 2. Simulates user interaction by sending a prompt: "Let's create algorithmic art."
 * 3. Asserts that the agent's response matches the expected output, confirming it claims to have created the art and files.
 * 4. Verifies that the expected files (`ephemeral_entanglement.md`, `index.html`, `sketch.js`) were actually generated in the output directory the agent was configured with.
 * 5. Compares the content of these generated files with reference files in the `expected/` directory to ensure correctness.
 * 6. Cleans up the output directory and installed dependencies after execution.
 *
 * The output directory is a temporary one created here and handed to the agent
 * through `ADK_SKILL_OUTPUT_DIR` (see `agent.ts`). Skill script output files are
 * only written to a directory the application declares, so an agent launched
 * from a checkout no longer drops script-named files into it.
 *
 * This test ensures the end-to-end flow of an agent using tools to generate and materialize files based on a high-level request.
 */
describe('Agent with skills that generates JS script and runs it locally', () => {
  let outputDir: string;

  beforeAll(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-script-js-out-'));
    await execAsync('npm install', {cwd: PROJECT_PATH});
  }, TEST_EXECUTION_TIMEOUT);

  it(
    'should run agent with skills successfully',
    async () => {
      const childProcess = spawn('npm', ['run', 'start'], {
        cwd: PROJECT_PATH,
        shell: true,
        env: {...process.env, ADK_SKILL_OUTPUT_DIR: outputDir},
      });

      let response = await sendInput(
        childProcess,
        'Let`s create algorithmic art.\n',
      );
      expect(response.toString()).toContain(
        'I have created an original algorithmic art piece titled **"Ephemeral Entanglement"**.\n\nFollowing the generative art movement philosophy, I\'ve generated three files for you:\n\n1.  **`ephemeral_entanglement.md`**: The algorithmic philosophy detailing the conceptual foundation of this piece. It explores the delicate dance between deterministic forces and stochastic drift, visualizing unseen connections in a dynamic system.\n2.  **`index.html`**: The interactive viewer for the generative art. It includes a user interface to adjust parameters like particle count, connection radius, and noise scale, allowing you to explore the algorithm\'s emergent behavior.\n3.  **`sketch.js`**: The meticulously crafted p5.js algorithm that brings the philosophy to life. It uses layered Perlin noise to drive a flow field, guiding particles that form ephemeral, glowing bonds when they come into proximity. \n\nYou can view the art by opening the `index.html` file in your web browser. Let the algorithmic dance begin!',
      );

      response = await sendInput(childProcess, 'exit\n');
      expect(response.toString()).toContain('');

      // verify that files were created in the declared output directory, and
      // not in the agent's working directory, and have the expected content
      const resultMdFile = await fs.readFile(
        path.join(outputDir, 'ephemeral_entanglement.md'),
        'utf-8',
      );
      const resultScriptFile = await fs.readFile(
        path.join(outputDir, 'sketch.js'),
        'utf-8',
      );
      const resultHtmlFile = await fs.readFile(
        path.join(outputDir, 'index.html'),
        'utf-8',
      );

      await expect(
        fs.access(`${PROJECT_PATH}/ephemeral_entanglement.md`),
      ).rejects.toThrow(/ENOENT/);
      await expect(fs.access(`${PROJECT_PATH}/sketch.js`)).rejects.toThrow(
        /ENOENT/,
      );
      await expect(fs.access(`${PROJECT_PATH}/index.html`)).rejects.toThrow(
        /ENOENT/,
      );

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
    await fs.rm(outputDir, {recursive: true, force: true}).catch(() => {});

    await fs
      .rm(`${PROJECT_PATH}/node_modules`, {recursive: true, force: true})
      .catch(() => {});
    await fs.unlink(`${PROJECT_PATH}/package-lock.json`).catch(() => {});
  });
});
