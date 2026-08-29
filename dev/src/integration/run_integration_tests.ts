/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger} from '@google/adk';
import {buildAgentRegistry} from '../conformance/yaml_agent_loader.js';
import {batchLoadYamlTestDefs} from '../conformance/yaml_test_loader.js';
import {TestRunner} from './test_runner.js';

const logger = getLogger();

/**
 * Runs every conformance test found under `testsDir` against the agents found
 * under `agentsDir`.
 *
 * @returns the number of tests that failed.
 */
export async function runIntegrationTests({
  agentsDir,
  testsDir,
  forceRunAll,
}: {
  agentsDir: string;
  testsDir: string;
  forceRunAll: boolean;
}): Promise<number> {
  const agentRegistry = await buildAgentRegistry(agentsDir);

  logger.debug(`Loading tests from ${testsDir}`);
  const testSpecs = await batchLoadYamlTestDefs(testsDir);
  logger.debug(testSpecs.size, 'tests found.');

  logger.debug('Running tests.');
  const successfulTests = [];
  const skippedTests = [];
  const failedTests: Array<{name: string; message: string}> = [];
  const testRunner = new TestRunner(agentRegistry);

  for (const [name, testInfo] of testSpecs) {
    logger.debug('Running test', name);
    try {
      const skipped = await testRunner.run(testInfo, forceRunAll);

      if (skipped) {
        skippedTests.push(name);
        logger.debug('Test skipped:', name);
        continue;
      }

      successfulTests.push(name);
      logger.debug('Test passed:', name);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failedTests.push({name, message});
      logger.error('Test failed:', name);
    }
  }

  logger.info(
    `${successfulTests.length} tests passed, ` +
      `${skippedTests.length} tests skipped, ` +
      `${failedTests.length} tests failed.`,
  );

  logger.info('Successful tests:', successfulTests.join(', '));
  logger.info('Skipped tests:', skippedTests.join(', '));
  logger.info('Failed tests:', failedTests.map((test) => test.name).join(', '));

  for (const test of failedTests) {
    logger.error(
      `FAILED ${test.name}\n  ${test.message.replaceAll('\n', '\n  ')}`,
    );
  }

  return failedTests.length;
}
