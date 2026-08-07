/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {registerConformanceIntegrations} from '../conformance/conformance_integrations.js';
import {batchLoadYamlAgentConfig} from '../conformance/yaml_agent_loader.js';
import {batchLoadYamlTestDefs} from '../conformance/yaml_test_loader.js';
import {AgentRegistry} from './agent_registry.js';
import {IntegrationRegistry} from './integration_registry.js';
import {TestRunner} from './test_runner.js';

/** A conformance test that threw, with the reason it threw. */
interface FailedTest {
  name: string;
  message: string;
}

/** Returns the human-readable reason an arbitrary thrown value carries. */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Indents every line of `text` by two spaces. */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

export async function runIntegrationTests({
  agentsDir,
  testsDir,
  forceRunAll,
}: {
  agentsDir: string;
  testsDir: string;
  forceRunAll: boolean;
}) {
  console.log(`Loading agents from ${agentsDir}`);
  const agentConfigs = await batchLoadYamlAgentConfig(agentsDir);
  console.log(agentConfigs.size, 'agents found');

  console.log('Registering conformance integrations.');
  const registry = new IntegrationRegistry();
  registerConformanceIntegrations(registry);
  console.log(registry.summary());

  console.log('Registering agents.');
  const agentRegistry = new AgentRegistry(registry);
  for (const [name, agentConfig] of agentConfigs) {
    agentRegistry.registerAgentConfig(name, agentConfig);
  }
  console.log(agentRegistry.summary());

  console.log(`Loading tests from ${testsDir}`);
  const testSpecs = await batchLoadYamlTestDefs(testsDir);
  console.log(testSpecs.size, 'tests found.');

  console.log('Running tests.');
  const successfulTests = [];
  const skippedTests = [];
  const failedTests: FailedTest[] = [];
  const testRunner = new TestRunner(agentRegistry);

  for (const [name, testInfo] of testSpecs) {
    console.log('\x1b[33mRunning test', name, '\x1b[0m\n');
    try {
      const skipped = await testRunner.run(testInfo, forceRunAll);

      if (skipped) {
        skippedTests.push(name);
        console.log('\n\x1b[33mTest skipped.\x1b[0m\n');
        continue;
      }

      successfulTests.push(name);
      console.log('\n\x1b[32mTest passed.\x1b[0m\n');
    } catch (error: unknown) {
      const message = failureMessage(error);
      failedTests.push({name, message});
      console.error(`\n\x1b[31mTest failed: ${name}\x1b[0m`);
      console.error(`${message}\n`);
    }
  }

  console.log(
    `\n\n${successfulTests.length} tests passed, ` +
      `${skippedTests.length} tests skipped, ` +
      `${failedTests.length} tests failed.`,
  );

  console.log('Successful tests:', successfulTests.join(', '));
  console.log('Skipped tests:', skippedTests.join(', '));
  console.log('Failed tests:', failedTests.map((test) => test.name).join(', '));

  for (const test of failedTests) {
    console.error(
      `\n\x1b[31mFAILED ${test.name}\x1b[0m\n${indent(test.message)}`,
    );
  }

  console.log('\n');
}
