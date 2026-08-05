import { Router, Request, Response, NextFunction } from 'express';
import { llmService } from '../services/llmService.js';
import { buildPublicPersona } from '../config/persona.js';
import { config } from '../config/env.js';
import { validateChatRequest } from '../middleware/validateChat.js';
import { chatBurstLimiter, chatRateLimiter, sessionRateLimiter } from '../middleware/rateLimiter.js';
import { requireSession, turnstileEnabled, verifyTurnstileToken } from '../middleware/turnstile.js';
import { issueSessionToken } from '../services/sessionToken.js';

export const chatRouter = Router();

/** Cached so the object isn't rebuilt on every request. */
const publicPersona = buildPublicPersona();

/**
 * GET /api/persona
 * Returns current active personality configuration
 */
chatRouter.get('/persona', (_req: Request, res: Response) => {
  // personalFacts sengaja nggak dikirim ke client — isinya data pribadi yang
  // cuma buat konsumsi system prompt, bukan buat dipajang di frontend.
  // buildPublicPersona pakai allowlist, jadi field sensitif yang ditambahin ke
  // PersonaProfile nanti nggak otomatis kebocoran.
  res.json({
    success: true,
    persona: publicPersona,
  });
});

/**
 * GET /api/config
 * Tells the frontend which gates are switched on, so it can render the
 * Turnstile widget only when the backend actually requires one. No secrets here.
 */
chatRouter.get('/config', (_req: Request, res: Response) => {
  res.json({
    success: true,
    turnstileRequired: turnstileEnabled(),
    limits: {
      maxMessages: config.limits.maxMessages,
      maxMessageChars: config.limits.maxMessageChars,
      maxTotalChars: config.limits.maxTotalChars,
    },
  });
});

/**
 * POST /api/session
 * Exchanges a Cloudflare Turnstile token for a short-lived session token.
 *
 * Verifying Turnstile once per conversation rather than once per message keeps
 * the chat usable: Turnstile tokens are single-use and expire within minutes.
 */
chatRouter.post(
  '/session',
  sessionRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!turnstileEnabled()) {
        res.status(404).json({
          success: false,
          error: 'Turnstile is not enabled on this deployment.',
          requestId: req.requestId,
        });
        return;
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';

      if (!token || token.length > 2048) {
        res.status(400).json({
          success: false,
          error: 'A valid "turnstileToken" is required.',
          requestId: req.requestId,
        });
        return;
      }

      const verdict = await verifyTurnstileToken(token, req.ip);

      if (!verdict.ok) {
        console.warn(
          `[${req.requestId}] Turnstile rejected (ip=${req.ip}): ${verdict.errorCodes.join(', ')}`
        );
        res.status(403).json({
          success: false,
          error: 'Turnstile verification failed.',
          requestId: req.requestId,
        });
        return;
      }

      const { token: sessionToken, expiresAt } = issueSessionToken(req.ip);
      res.json({ success: true, sessionToken, expiresAt });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/chat
 * Handles chat completion (supports standard JSON and SSE Streaming)
 */
chatRouter.post(
  '/chat',
  chatBurstLimiter,
  chatRateLimiter,
  requireSession,
  validateChatRequest,
  async (req: Request, res: Response, next: NextFunction) => {
    // validateChatRequest guarantees this is populated.
    const { messages, stream, temperature } = req.validatedChat!;

    /**
     * Tied to the response lifecycle so a user closing the tab or hitting stop
     * actually cancels the upstream call. Previously an abandoned stream kept
     * generating — and kept billing — until the model finished on its own.
     */
    const abortController = new AbortController();
    let clientGone = false;

    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        abortController.abort();
      }
    });

    try {
      if (stream) {
        // Setup Server-Sent Events (SSE) headers for real-time streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        // Stops Render's proxy (and nginx-alikes) from buffering the stream.
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const streamResponse = await llmService.streamChatCompletion(
          messages,
          temperature,
          abortController.signal
        );

        let finishReason: string | null = null;
        for await (const chunk of streamResponse) {
          if (clientGone) break;

          const choice = chunk.choices[0] as
            | { delta?: { content?: string }; finish_reason?: string | null }
            | undefined;
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }

          const content = choice?.delta?.content || '';
          if (content) {
            res.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        }

        if (clientGone) {
          console.warn(`[${req.requestId}] Client disconnected mid-stream; upstream call aborted.`);
          return;
        }

        if (finishReason === 'length') {
          console.warn(
            `[${req.requestId}] Stream truncated: hit MAX_OUTPUT_TOKENS limit (${config.limits.maxOutputTokens} tokens).`
          );
        }

        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const reply = await llmService.chatCompletion(messages, temperature, abortController.signal);

      if (clientGone) return;

      res.json({
        success: true,
        reply,
      });
    } catch (error) {
      // A cancellation caused by our own abort is expected, not a failure.
      if (clientGone) {
        console.warn(`[${req.requestId}] Request aborted after client disconnect.`);
        if (!res.writableEnded) res.end();
        return;
      }

      // Everything else goes to the shared handler, which logs the detail and
      // returns a generic message. The old code echoed error.message to the
      // client, exposing upstream provider and quota internals.
      next(error);
    }
  }
);
