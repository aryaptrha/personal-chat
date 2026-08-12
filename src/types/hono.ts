import type { ValidatedChatRequest } from './chat.js';

export type Env = {
  Variables: {
    requestId: string;
    clientIp: string;
    trustedCaller?: boolean;
    validatedChat?: ValidatedChatRequest;
  };
  Bindings: {
    LLM_API_KEY?: string;
    LLM_BASE_URL?: string;
    LLM_MODEL?: string;
    CORS_ORIGIN?: string;
    API_SHARED_SECRET?: string;
    TURNSTILE_SECRET_KEY?: string;
    SESSION_TOKEN_SECRET?: string;
    USE_DUMMY_MODE?: string;
    NODE_ENV?: string;
    [key: string]: unknown;
  };
};
