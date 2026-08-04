import { Request, Response, NextFunction } from 'express';

interface HttpishError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ success: false, error: 'Not found', requestId: req.requestId });
}

/**
 * Maps a thrown error to a status code and a message that is safe to return.
 *
 * The old handler echoed `error.message` straight to the client, which could
 * surface upstream provider errors, the configured base URL, quota details, or
 * hints about the API key. Details now stay in the logs; the client gets a
 * request id to quote instead.
 */
function classify(err: HttpishError): { status: number; message: string } {
  // Errors raised by express.json() before our handlers ever run.
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
  // Only 4xx statuses come from client mistakes and are safe to describe.
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return { status, message: err.message || 'Bad request.' };
  }

  return { status: 500, message: 'Internal server error.' };
}

export function errorHandler(
  err: HttpishError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const { status, message } = classify(err);

  // Full detail server-side only, correlated by request id.
  console.error(`[${req.requestId}] ${req.method} ${req.originalUrl} failed (${status}):`, err);

  // An SSE response has already committed its status and headers; the only thing
  // left is to signal the interruption in-band and close the stream cleanly.
  if (res.headersSent) {
    if (!res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify({ error: 'Stream interrupted' })}\n\n`);
      } catch {
        // Socket already gone — nothing useful left to do.
      }
      res.end();
    }
    return;
  }

  if (res.destroyed) {
    next(err);
    return;
  }

  res.status(status).json({ success: false, error: message, requestId: req.requestId });
}
