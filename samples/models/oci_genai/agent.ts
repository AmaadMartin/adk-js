/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An agent that answers through a model hosted on OCI Generative AI.
 *
 * The provider is an optional peer dependency, so install the OCI SDK first:
 *   npm install oci-common oci-generativeaiinference
 *
 * It reads OCI credentials from `~/.oci/config` and the compartment from
 * `OCI_COMPARTMENT_ID`. Set `OCI_SERVICE_ENDPOINT` for a region other than
 * us-chicago-1, and `OCI_ENDPOINT_ID` to reach a dedicated endpoint.
 *
 * Run (needs an OCI account, and bills it):
 *   OCI_COMPARTMENT_ID=ocid1.compartment.oc1..example \
 *     npm run sample -- samples/models/oci_genai/agent.ts
 */

import {LlmAgent, OciGenAiLlm} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'oci_genai_agent',
  model: new OciGenAiLlm({
    model: 'google.gemini-2.5-flash',
    // Reasoning models honour this and other models ignore it. It is the
    // largest cost knob for a reasoning model.
    reasoningEffort: 'LOW',
  }),
  description: 'Answers questions through a model hosted on OCI.',
  instruction: 'You are a helpful assistant. Answer in one short paragraph.',
});
