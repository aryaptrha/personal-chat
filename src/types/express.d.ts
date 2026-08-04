import type { ValidatedChatRequest } from './chat.js';

declare global {
  namespace Express {
    interface Request {
      /** Populated by `validateChatRequest`; never read the raw body downstream. */
      validatedChat?: ValidatedChatRequest;
      /** Correlation id echoed to the client so logs can be matched without leaking internals. */
      requestId?: string;
      /**
       * Set when the caller proved knowledge of `API_SHARED_SECRET`, i.e. it is a
       * server-side proxy rather than a browser. Such callers have no `Origin`
       * header, so the origin guard stands down for them.
       */
      trustedCaller?: boolean;
    }
  }
}
