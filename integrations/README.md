# ADK Integrations

This package contains integrations for the Google ADK.

## OpenAI Responses API

`OpenAiResponsesLlm` drives a model through the OpenAI Responses API
(`/v1/responses`). It is experimental and its surface may change.

```ts
import {LlmAgent} from '@google/adk';
import {OpenAiResponsesLlm} from '@google/adk-integrations';

const agent = new LlmAgent({
  name: 'my_openai_agent',
  model: new OpenAiResponsesLlm({
    model: 'gpt-5',
    apiKey: process.env['OPENAI_API_KEY'],
  }),
  instruction: 'You are a helpful assistant.',
});
```

Azure exposes the same API through an OpenAI-compatible endpoint. Set `model`
to the deployment name; the key falls back to `AZURE_OPENAI_API_KEY`.

```ts
import {AzureOpenAiResponsesLlm} from '@google/adk-integrations';

const model = new AzureOpenAiResponsesLlm({
  model: 'my-deployment',
  azureEndpoint: 'https://example.openai.azure.com/',
});
```

The provider registers no model patterns, so select it by passing an instance
as `LlmAgent.model`. For anything beyond the API key — organization, base URL,
timeouts, retries, custom headers — pass a pre-configured `OpenAI` client as
`client`.
