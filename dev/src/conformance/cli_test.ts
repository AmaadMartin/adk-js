/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import {TestRunner} from '../integration/test_runner.js';
import {TestCaseSpec} from '../integration/test_types.js';
import {errorMessage} from '../utils/error_utils.js';
import {isFileExists} from '../utils/file_utils.js';
import {AdkLogger} from '../utils/logger.js';
import {
  ConformanceMode,
  ConformanceStatus,
  ConformanceTestResult,
  ConformanceTestSummary,
} from './conformance_types.js';
import {generatedFilePaths} from './generated_file_utils.js';
import {generateMarkdownReport} from './markdown_report.js';
import {loadAgentRegistry} from './yaml_agent_loader.js';
import {batchLoadTestSpecs, loadTestInfo} from './yaml_test_loader.js';

const logger = new AdkLogger({label: 'Conformance', colorize: {all: true}});

/** Options of `adk conformance test`. */
export interface ConformanceTestOptions {
  /** Directories to search for test cases. */
  testPaths: string[];
  /** Directory of the agent definitions the specs name. */
  agentsDir: string;
  mode: ConformanceMode;
  generateReport: boolean;
  /** Where to write the report. Defaults to the working directory. */
  reportDir?: string;
  /** Which fixture set to replay. The non-streaming one when unset. */
  streamingMode?: StreamingMode;
  /** Run the cases the runner would otherwise skip. */
  force: boolean;
}

/**
 * Replays every recorded test case under `testPaths` and reports the outcome.
 *
 * A case whose fixtures were never recorded is skipped, as in adk-python.
 *
 * @throws if the run cannot start, which includes `live` mode.
 */
export async function runConformanceTest({
  testPaths,
  agentsDir,
  mode,
  generateReport,
  reportDir,
  streamingMode,
  force,
}: ConformanceTestOptions): Promise<ConformanceTestSummary> {
  if (mode === ConformanceMode.LIVE) {
    throw new Error('Live mode is not implemented yet.');
  }

  const fixtureMode = streamingMode ?? StreamingMode.NONE;
  const testRunner = new TestRunner(await loadAgentRegistry(agentsDir));

  const testCases: TestCaseSpec[] = [];
  for (const testPath of testPaths) {
    testCases.push(...(await batchLoadTestSpecs(testPath)));
  }
  testCases.sort((a, b) => a.name.localeCompare(b.name));

  const results: ConformanceTestResult[] = [];
  for (const testCase of testCases) {
    results.push(await runTestCase(testRunner, testCase, fixtureMode, force));
  }

  const summary: ConformanceTestSummary = {streamingMode, results};
  if (generateReport) {
    logger.info(
      `Report written to ${await generateMarkdownReport(summary, reportDir)}`,
    );
  }
  return summary;
}

async function runTestCase(
  testRunner: TestRunner,
  testCase: TestCaseSpec,
  streamingMode: StreamingMode,
  force: boolean,
): Promise<ConformanceTestResult> {
  const result = {
    category: testCase.category,
    name: testCase.name,
    description: testCase.spec.description,
  };

  const {recordingsFile} = generatedFilePaths(testCase.dir, streamingMode);
  if (!(await isFileExists(recordingsFile))) {
    logger.warn(`Skipping ${testCase.name}: no recordings`);
    return {...result, status: ConformanceStatus.SKIPPED};
  }

  try {
    const testInfo = await loadTestInfo(testCase, streamingMode);
    const skipped = await testRunner.run(testInfo, force);
    return {
      ...result,
      status: skipped ? ConformanceStatus.SKIPPED : ConformanceStatus.PASSED,
    };
  } catch (error: unknown) {
    return {
      ...result,
      status: ConformanceStatus.FAILED,
      error: errorMessage(error),
    };
  }
}
