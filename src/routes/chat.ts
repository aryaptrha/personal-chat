import { Router, Request, Response } from 'express';
import { llmService } from '../services/llmService.js';
import { ChatRequest } from '../types/chat.js';
import { defaultPersona } from '../config/persona.js';

export const chatRouter = Router();

/**
 * GET /api/persona
 * Returns current active personality configuration
 */
chatRouter.get('/persona', (_req: Request, res: Response) => {
  // personalFacts sengaja nggak dikirim ke client — isinya data pribadi yang
  // cuma buat konsumsi system prompt, bukan buat dipajang di frontend.
  const { personalFacts, ...publicPersona } = defaultPersona;

  res.json({
    success: true,
    persona: publicPersona,
  });
});

/**
 * POST /api/chat
 * Handles chat completion (supports standard JSON and SSE Streaming)
 */
chatRouter.post('/chat', async (req: Request, res: Response) => {
  try {
    const { messages, stream = false, temperature = 0.95 } = req.body as ChatRequest;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request: "messages" array is required.',
      });
    }

    if (stream) {
      // Setup Server-Sent Events (SSE) headers for real-time streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const streamResponse = await llmService.streamChatCompletion(messages, temperature);

      for await (const chunk of streamResponse) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }

      res.write('data: [DONE]\n\n');
      return res.end();
    } else {
      const reply = await llmService.chatCompletion(messages, temperature);
      return res.json({
        success: true,
        reply,
      });
    }
  } catch (error: any) {
    console.error('Chat endpoint error:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Failed to process chat request',
        details: error?.message || 'Unknown error',
      });
    } else {
      res.write(`data: ${JSON.stringify({ error: 'Stream interrupted' })}\n\n`);
      return res.end();
    }
  }
});
