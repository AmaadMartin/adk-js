/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger} from '@google/adk';
import {registerConformanceIntegrations} from '../conformance/conformance_integrations.js';
import {batchLoadYamlAgentConfig} from '../conformance/yaml_agent_loader.js';
import {batchLoadYamlTestDefs} from '../conformance/yaml_test_loader.js';
import {AgentRegistry} from './agent_registry.js';
import {IntegrationRegistry} from './integration_registry.js';
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
  logger.debug(`Loading agents from ${agentsDir}`);
  const agentConfigs = await batchLoadYamlAgentConfig(agentsDir);
  logger.debug(agentConfigs.size, 'agents found');

  logger.debug('Registering conformance integrations.');
  const registry = new IntegrationRegistry();
  registerConformanceIntegrations(registry);
  logger.debug(registry.summary());

  logger.debug('Registering agents.');
  const agentRegistry = new AgentRegistry(registry);
  for (const [name, agentConfig] of agentConfigs) {
    agentRegistry.registerAgentConfig(name, agentConfig);
  }
  logger.debug(agentRegistry.summary());

  logger.debug(`Loading tests from ${testsDir}`);
  const testSpecs = await batchLoadYamlTestDefs(testsDir);
  logger.debug(testSpecs.size, 'tests found.');

  logger.debug('Running tests.');
  const successfulTests = [];
  const skippedTests = [];
  const failedTests = [];
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
    } catch (_: unknown) {
      failedTests.push(name);
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
  logger.info('Failed tests:', failedTests.join(', '));

  return failedTests.length;
}
