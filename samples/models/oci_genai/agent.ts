/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An agent served by a model on Oracle Cloud Infrastructure Generative AI.
 *
 * Setup:
 *   npm install oci-common oci-generativeaiinference
 *   export OCI_COMPARTMENT_ID=ocid1.compartment.oc1..your-compartment
 *
 * `OCIGenAILlm` reads `~/.oci/config` for API-key credentials by default, so
 * the profile named there must be able to call the Generative AI service. Set
 * `OCI_SERVICE_ENDPOINT` to reach a region other than us-chicago-1.
 *
 * Run:
 *   npm run sample -- samples/models/oci_genai/agent.ts
 */

import {FunctionTool, LlmAgent, OCIGenAILlm} from '@google/adk';
import {z} from 'zod';

const readTemperature = new FunctionTool({
  name: 'read_temperature',
  description: 'Reads the current temperature of a city, in Celsius.',
  parameters: z.object({city: z.string().describe('The city to look up.')}),
  execute: async ({city}) => ({city, celsius: 22}),
});

export const rootAgent = new LlmAgent({
  name: 'oci_weather_agent',
  description: 'Answers weather questions using a model hosted on OCI.',
  instruction:
    'Answer the user in one sentence. Call read_temperature when you ' +
    'need the current temperature of a city.',
  model: new OCIGenAILlm({
    model: 'google.gemini-2.0-flash-001',
    compartmentId: process.env['OCI_COMPARTMENT_ID'],
  }),
  tools: [readTemperature],
});
