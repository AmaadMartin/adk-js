# ADK Labs

This folder contains experimental features and integrations for the Agent
Development Kit (ADK).

> [!WARNING]
> All code in this folder is **experimental** and subject to change or deletion
> at any time without notice. Do not rely on these features for production use.

## OpenAI (experimental)

`openai/` drives GPT models through the OpenAI Responses API. It needs the
`openai` package, which ADK declares as an optional peer dependency:

```bash
npm install openai
```

Instantiate the model and assign it to an agent:

```ts
import {LlmAgent} from '@google/adk';
import {OpenAIResponsesLlm} from '@google/adk';

const agent = new LlmAgent({
  name: 'my_openai_agent',
  model: new OpenAIResponsesLlm({model: 'gpt-5'}),
  instruction: 'You are a helpful assistant.',
});
```

To reach a host that speaks the OpenAI API, or to configure anything else the
client supports, build an `OpenAI` client yourself and pass it as `client`.
Each model instance keeps its own client, so one process can talk to several
hosts. To send every request to one compatible host instead, leave `client`
unset and set `OPENAI_BASE_URL`, which the default client reads.
