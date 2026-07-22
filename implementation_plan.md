## Task

### User intent with respect to ADK

Implement the PubSub messaging toolset in the `adk-js` repository to achieve parity with the existing `adk-python` implementation. This allows LLM agents to interact with Google Cloud Pub/Sub, specifically to publish, pull, and acknowledge messages.

### Feature Description

Add a `PubSubToolset` containing tools for `publish_message` (PublishMessageTool), `pull_messages` (PullMessageTool), and `acknowledge_messages` (AcknowledgeMessageTool). Provide configuration classes mimicking `PubSubToolConfig` and `PubSubCredentialsConfig`.

### Use Cases & Examples

- An agent orchestrating event-driven architectures can publish a notification message to a topic.
- An agent acting as a consumer can pull events from a subscription and process them.

## Context

### ADK Context

- Reference context: `adk-python/src/google/adk/tools/pubsub/pubsub_toolset.py` and `message_tool.py`.
- General context: Tools must implement `BaseTool` or extend `FunctionTool` following the standard `adk-js` tool design patterns. `PubSubToolset` implements `BaseToolset`.

### Language Specific Context

- Target language: TypeScript (Node.js ecosystem).
- Target repo: `adk-js`
- General context: The toolset should integrate the `@google-cloud/pubsub` Node.js client library. We will place this toolset in the `core/src/tools/pubsub` directory and add `@google-cloud/pubsub` to `core/package.json`.

## Definition

### Data Models

- `PubSubToolConfig`: `{ projectId?: string; }`
- `PubSubCredentialsConfig`: Configuration for GCP auth (for custom scopes, falling back to Application Default Credentials via `google-auth-library`).

### Inputs

- **PublishMessageTool**: `topicName` (string), `message` (string), `attributes` (Record<string, string>, optional), `orderingKey` (string, optional).
- **PullMessageTool**: `subscriptionName` (string), `maxMessages` (number, default 1), `autoAck` (boolean, default false).
- **AcknowledgeMessageTool**: `subscriptionName` (string), `ackIds` (string[]).

### Outputs

- **PublishMessageTool**: `{ messageId: string }` or error object `{ status: 'ERROR', error_details: string }`.
- **PullMessageTool**: `{ messages: Array<{ messageId, data, attributes, orderingKey, publishTime, ackId }> }` or error object.
- **AcknowledgeMessageTool**: `{ status: 'SUCCESS' }` or error object.

### Side Effects

- Cloud Pub/Sub topics will receive messages.
- Subscriptions will have messages pulled/acknowledged.

## Constraints

### Invariants

- Proper authentication using Google Cloud Application Default Credentials by default.
- Handle base64 / utf8 decoding logic for Pulled messages, mirroring python (`_decode_message_data`).

### Preconditions

- The GCP project has Pub/Sub API enabled.
- The `topicName` or `subscriptionName` exist and caller has correct IAM roles.

### Postconditions

- Operations successfully interact with Google Cloud API and return standard statuses without crashing the agent execution loop on user error.

### Error Handling Protocols

- Return JSON objects containing `status: 'ERROR'` and `error_details` similar to the Python parity target, allowing the LLM to read the error and correct its behavior.

### Breaking Change Analysis

- No breaking changes. This is a purely additive feature.

### Testing

- #### Unit tests with >=95% New Line Coverage
  Mock the `@google-cloud/pubsub` `PubSub` client to test all success and error paths for the 3 tools, checking that the correct toolset filters are applied and parameters are mapped properly.
- #### Integration tests
  Target a real Google Cloud Pub/Sub topic and subscription using test projects if credentials can be provisioned.
- #### Manual e2e test
  A sample script that initializes `PubSubToolset`, passes it to an Agent, and queries the agent to publish and pull messages.
