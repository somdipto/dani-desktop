import type { ModelMessage } from "ai";

// Conversation messages are full ModelMessages so tool calls + tool results are
// carried across turns (otherwise the model forgets actions it already took and
// repeats them — e.g. re-asking permission to open the same URL).
export type ChatMessage = ModelMessage;
