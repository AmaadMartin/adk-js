# OCIGenAILlm

`OCIGenAILlm` runs an agent against a model hosted on Oracle Cloud
Infrastructure Generative AI. It speaks the `/20231130/` GenericChat API, so
one class serves the Llama, Gemini, Gemma, Grok, Mistral and NVIDIA models OCI
offers.

## Introduction

An OCI customer keeps inference inside their own tenancy and pays for it
through their existing OCI account. Reaching those models needs more than a
base URL: OCI signs every request with a key pair, addresses a compartment by
OCID, and offers a model either on shared capacity or on a dedicated endpoint.
`OCIGenAILlm` holds that configuration and converts between ADK's request and
response types and the GenericChat wire format.

It is a `BaseLlm` subclass registered in `LLMRegistry` against seven model-name
patterns, so `new LlmAgent({model: 'google.gemini-2.0-flash-001'})` resolves to
it without any import. Construct it directly instead when you need to set the
compartment, the endpoint or the token budget in code. The Oracle SDK is an
optional peer dependency: importing `@google/adk` does not load it, and the
first call is what pulls it in.

## Get started

Install the two Oracle packages, then point the agent at a model:

```bash
npm install oci-common oci-generativeaiinference
export OCI_COMPARTMENT_ID=ocid1.compartment.oc1..your-compartment
```

```ts
import {LlmAgent, OCIGenAILlm} from '@google/adk';

export const rootAgent = new LlmAgent({
  name: 'oci_agent',
  instruction: 'Answer in one sentence.',
  model: new OCIGenAILlm({
    model: 'google.gemini-2.0-flash-001',
    compartmentId: process.env['OCI_COMPARTMENT_ID'],
  }),
});
```

A runnable version of this agent, with a tool attached, is in
[`samples/models/oci_genai/agent.ts`](../../../../samples/models/oci_genai/agent.ts).

## Configuration

Every option below is also readable from the environment, so the same code runs
against a different tenancy or region without an edit.

| Option             | Environment variable   | Default                         |
| ------------------ | ---------------------- | ------------------------------- |
| `model`            | —                      | `google.gemini-2.5-flash`       |
| `compartmentId`    | `OCI_COMPARTMENT_ID`   | none; a call without one throws |
| `endpointId`       | `OCI_ENDPOINT_ID`      | none; on-demand serving is used |
| `serviceEndpoint`  | `OCI_SERVICE_ENDPOINT` | the us-chicago-1 endpoint       |
| `authType`         | —                      | `API_KEY`                       |
| `authProfile`      | —                      | `DEFAULT`                       |
| `authFileLocation` | —                      | `~/.oci/config`                 |
| `maxTokens`        | —                      | `2048`                          |
| `reasoningEffort`  | —                      | none; OCI chooses               |

A constructor value wins over its environment variable.

### Serving mode

Set `endpointId` to reach a model you host on a dedicated AI cluster. The
provider then sends dedicated serving mode and `model` becomes informational.
With no endpoint id it sends on-demand serving mode with `model` as the model
id.

### Authentication

`API_KEY` is the default and reads the OCI config file, so the profile named by
`authProfile` must be able to call the Generative AI service. Use
`INSTANCE_PRINCIPAL` from a compute instance and `RESOURCE_PRINCIPAL` from a
function or a container instance; neither reads the config file.

### Model-name patterns

`LLMRegistry` resolves `meta.llama-*`, `google.gemini-*`, `google.gemma-*`,
`xai.grok-*`, `mistralai.mistral-*`, `mistralai.mixtral-*` and `nvidia.*` to
this class. An OCI model id carries a vendor prefix, so it never collides with
the bare `gemini-*` names the Gemini provider claims.

## Streaming

Pass `stream: true` and the provider yields one partial response per text delta
as it arrives, then a final response carrying the whole text, every tool call
and the token usage. An empty stream yields the final response only. Tool-call
deltas are accumulated by index, so a model that splits one call's arguments
across several frames still produces one call.

```ts
for await (const response of llm.generateContentAsync(request, true)) {
  if (response.partial) {
    process.stdout.write(response.content?.parts?.[0]?.text ?? '');
  }
}
```

## What it does not do

`connect()` throws. OCI Generative AI serves the request/response chat API
only, so there is no bidirectional live session to open.

Only the GenericChat format is implemented. The Cohere chat format that OCI
also exposes, and the `embedText`, `generateText` and `summarizeText`
operations, are not reached through this provider.

## Failure modes

A call with no compartment id throws before any request is sent. A missing
Oracle package throws an error naming both the package and the `npm install`
command that fixes it. Errors the service itself returns propagate unchanged —
the Oracle client already retries what is worth retrying, and this provider
adds no retry of its own.

Tool-call arguments that are not valid JSON become an empty argument object
rather than an error, because a single malformed call should not fail the turn.
A stream frame that is not JSON is logged at debug level and skipped.
