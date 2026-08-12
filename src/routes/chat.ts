import { Hono } from 'hono';
import { streamText } from 'hono/streaming';
import { llmService } from '../services/llmService.js';
import { buildPublicPersona } from '../config/persona.js';
import { config } from '../config/env.js';
import { validateChatRequest } from '../middleware/validateChat.js';
import { chatBurstLimiter, chatRateLimiter, sessionRateLimiter } from '../middleware/rateLimiter.js';
import { requireSession, turnstileEnabled, verifyTurnstileToken } from '../middleware/turnstile.js';
import { issueSessionToken } from '../services/sessionToken.js';
import type { Env } from '../types/hono.js';

export const chatRouter = new Hono<Env>();

const publicPersona = buildPublicPersona();

chatRouter.get('/persona', (c) => {
  return c.json({
    success: true,
    persona: publicPersona,
  });
});

chatRouter.get('/config', (c) => {
  return c.json({
    success: true,
    turnstileRequired: turnstileEnabled(),
    limits: {
      maxMessages: config.limits.maxMessages,
      maxMessageChars: config.limits.maxMessageChars,
      maxTotalChars: config.limits.maxTotalChars,
    },
  });
});

chatRouter.post('/session', sessionRateLimiter, async (c) => {
  const reqId = c.get('requestId');
  const ip = c.get('clientIp');

  if (!turnstileEnabled()) {
    return c.json(
      {
        success: false,
        error: 'Turnstile is not enabled on this deployment.',
        requestId: reqId,
      },
      404
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';

  if (!token || token.length > 2048) {
    return c.json(
      {
        success: false,
        error: 'A valid "turnstileToken" is required.',
        requestId: reqId,
      },
      400
    );
  }

  const verdict = await verifyTurnstileToken(token, ip);

  if (!verdict.ok) {
    console.warn(
      `[${reqId}] Turnstile rejected (ip=${ip}): ${verdict.errorCodes.join(', ')}`
    );
    return c.json(
      {
        success: false,
        error: 'Turnstile verification failed.',
        requestId: reqId,
      },
      403
    );
  }

  const { token: sessionToken, expiresAt } = issueSessionToken(ip);
  return c.json({ success: true, sessionToken, expiresAt });
});

chatRouter.post(
  '/chat',
  chatBurstLimiter,
  chatRateLimiter,
  requireSession,
  validateChatRequest,
  async (c) => {
    const validatedChat = c.get('validatedChat')!;
    const { messages, stream, temperature } = validatedChat;
    const reqId = c.get('requestId');

    if (stream) {
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache, no-transform');
      c.header('Connection', 'keep-alive');
      c.header('X-Accel-Buffering', 'no');

      return streamText(c, async (streamTarget) => {
        const streamResponse = await llmService.streamChatCompletion(
          messages,
          temperature
        );

        let finishReason: string | null = null;
        for await (const chunk of streamResponse) {
          const choice = chunk.choices[0] as
            | { delta?: { content?: string }; finish_reason?: string | null }
            | undefined;
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }

          const content = choice?.delta?.content || '';
          if (content) {
            await streamTarget.write(`data: ${JSON.stringify({ content })}\n\n`);
          }
        }

        if (finishReason === 'length') {
          console.warn(
            `[${reqId}] Stream truncated: hit MAX_OUTPUT_TOKENS limit (${config.limits.maxOutputTokens} tokens).`
          );
        }

        await streamTarget.write('data: [DONE]\n\n');
      });
    }

    const reply = await llmService.chatCompletion(messages, temperature);

    return c.json({
      success: true,
      reply,
    });
  }
);
