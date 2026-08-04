/** Roles a client is allowed to send. `system` is deliberately excluded. */
export type ClientRole = 'user' | 'assistant';

export type MessageRole = ClientRole | 'system';

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
}

/**
 * Result of `validateChatRequest`. Built field by field from the raw body, so
 * nothing the client sends can reach the LLM call without passing validation.
 */
export interface ValidatedChatRequest {
  messages: Array<{ role: ClientRole; content: string }>;
  stream: boolean;
  temperature: number;
}
