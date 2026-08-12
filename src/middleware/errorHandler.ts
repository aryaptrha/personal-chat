import type { Context } from 'hono';
import type { Env } from '../types/hono.js';

interface HttpishError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
}

export function notFoundHandler(c: Context<Env>): Response {
  return c.json({ success: false, error: 'Not found', requestId: c.get('requestId') }, 404);
}

function classify(err: HttpishError): { status: number; message: string } {
  if (err.type === 'entity.too.large') {
    return { status: 413, message: 'Request body too large.' };
  }
  if (err.type === 'entity.parse.failed') {
    return { status: 400, message: 'Malformed JSON body.' };
  }
  if (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported') {
    return { status: 415, message: 'Unsupported content encoding.' };
  }

  const status = err.status ?? err.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { status, message: err.message || 'Bad request.' };
  }

  return { status: 500, message: 'Internal server error.' };
}

export function errorHandler(err: Error, c: Context<Env>): Response {
  const reqId = c.get('requestId');
  const { status, message } = classify(err as HttpishError);

  console.error(`[${reqId}] ${c.req.method} ${c.req.url} failed (${status}):`, err);

  return c.json(
    { success: false, error: message, requestId: reqId },
    status as any
  );
}
