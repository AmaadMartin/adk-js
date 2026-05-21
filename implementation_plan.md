# Implementation Plan: Gemini Interaction API Integration in adk-js

This plan outlines the steps required to implement the Gemini Interaction API in adk-js. This integration will enable stateful conversations (using server-side interaction history tracking) while mirroring the functionality already present in adk-python.

## Objective

Integrate the next-generation Gemini Interaction API into the adk-js core, allowing agents to maintain server-side state, trace intermediate reasoning steps, and minimize payload overhead across progressive multi-turn requests.

## Detailed Phases

### Phase 1: Interface & Type Modifications

We need to update the internal request and response models to support carrying the interaction ID.

1. **Update LlmRequest (`core/src/models/llm_request.ts`)**:
   Add the optional property `previousInteractionId` of type `string`.

   ```typescript
   export interface LlmRequest {
     // ... existing fields
     previousInteractionId?: string;
   }
   ```

2. **Update LlmResponse (`core/src/models/llm_response.ts`)**:
   Add the optional property `interactionId` of type `string`.
   ```typescript
   export interface LlmResponse {
     // ... existing fields
     interactionId?: string;
   }
   ```
   _(Note: Since Event extends LlmResponse in core/src/events/event.ts, this automatically equips session events to carry the interaction ID)._

---

### Phase 2: Stateful Request Processor

Create a request preprocessor to dynamically resolve and chain conversations using the interaction ID from previous events.

1. **Create `interactions_request_processor.ts` (`core/src/agents/processors/interactions_request_processor.ts`)**:
   - Define `InteractionsRequestProcessor` extending `BaseLlmRequestProcessor`.
   - Logic in `runAsync`:
     - Verify the agent uses the Gemini (Google) model and has `useInteractionsApi` enabled.
     - Traverse session events backwards to locate the latest valid interaction ID:
       ```typescript
       const events = invocationContext.session.events;
       for (let i = events.length - 1; i >= 0; i--) {
         const event = events[i];
         // Skip events not belonging to the current branch or author
         if (
           event.branch === invocationContext.branch &&
           event.author === agent.name &&
           event.interactionId
         ) {
           llmRequest.previousInteractionId = event.interactionId;
           break;
         }
       }
       ```
   - Export a constant singleton instance: `INTERACTIONS_REQUEST_PROCESSOR`.

2. **Register the Processor (`core/src/agents/llm_agent.ts`)**:
   - Import `INTERACTIONS_REQUEST_PROCESSOR`.
   - Register it in the default `this.requestProcessors` array, immediately after `CONTENT_REQUEST_PROCESSOR`.
   - Export it from `core/src/common.ts` alongside other processors.

---

### Phase 3: Interaction Utility & Payload Transformation

Create a mapping layer between ADK types and the `@google/genai` Interaction API schemas.

1. **Create `interactions_utils.ts` (`core/src/models/interactions_utils.ts`)**:
   - **Payload Trimming Helper:**
     - Implement `getLatestUserContents(contents: Content[]): Content[]` to slice and return only the latest continuous user turn when `previousInteractionId` is present.
   - **Request Converters:**
     - `convertPartToInteractionContent(part: Part): object | null`: Map standard parts (text, function calls, function responses, media data, code execution results) to the Interaction API structured objects.
     - `convertContentToTurn(content: Content): object`: Map roles (user, model, system) and map parts.
     - `convertContentsToTurns(contents: Content[]): object[]`.
     - `convertToolsConfigToInteractionsFormat(config: GenerateContentConfig): object[]`: Map tool definitions (specifically function declarations) to structured tool parameters.
   - **Response Converters:**
     - `convertInteractionOutputToPart(output: any): Part | null`: Convert interaction output types back into standard Part structures.
     - `convertInteractionToLlmResponse(interaction: any): LlmResponse`: Parse final structured Interaction object into a consolidated LlmResponse.
     - `convertInteractionEventToLlmResponse(event: any, aggregatedParts: Part[], interactionId: string): LlmResponse | null`: Parse streaming Server-Sent Events (SSE) delta updates.
   - **Core Runner:**
     - `generateContentViaInteractions(apiClient: GoogleGenAI, llmRequest: LlmRequest, stream: boolean)`:
       - Trim contents if previousInteractionId exists.
       - Call `apiClient.interactions.create(...)` (with stream: true/false).
       - Iterate and yield partial and final responses.

---

### Phase 4: Gemini Model Class Integration

Equip the main model execution block to toggle and run the new Interactions flow.

1. **Modify GeminiParams and Gemini Class (`core/src/models/google_llm.ts`)**:
   - Add `useInteractionsApi?: boolean` to `GeminiParams`.
   - Declare `readonly useInteractionsApi: boolean;` in the `Gemini` class (defaulting to false).
   - Update constructor to initialize `this.useInteractionsApi = !!params.useInteractionsApi;`.

2. **Update generateContentAsync**:
   - Add toggle check at top of method:
     ```typescript
     if (this.useInteractionsApi) {
       yield *
         generateContentViaInteractions(this.apiClient, llmRequest, stream);
       return;
     }
     ```

---

### Phase 5: Verification & Testing Plan

#### 1. Unit Testing

- Create `interactions_utils_test.ts` (`core/test/models/interactions_utils_test.ts`):
  - Test mapping of parts to interaction turns and vice-versa.
  - Test payload trimming (`getLatestUserContents`).
  - Mock `@google/genai` client `interactions.create` and verify async generator yields progressive LlmResponse events.
- Create `interactions_request_processor_test.ts` (`core/test/agents/processors/interactions_request_processor_test.ts`):
  - Validate extraction of `interactionId` from mock session history.

#### 2. Integration Verification

- Write scratch script (`/brain/scratch/verify_interactions.ts`) that:
  - Instantiates Gemini with `useInteractionsApi: true`.
  - Executes a two-turn conversation.
  - Confirms second request payload sent has trimmed history and contains `previousInteractionId`.
