import { Request, Response, NextFunction } from 'express';
import { config } from '../config/env.js';
import { ClientRole } from '../types/chat.js';

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * Drops control characters that carry no meaning in chat text but do corrupt log
 * lines and SSE framing. Tab, newline and carriage return are preserved.
 *
 * Written as a codepoint filter rather than a regex so no literal control
 * characters have to live in this source file.
 */
function stripControlChars(input: string): string {
  let output = '';

  for (const char of input) {
    const code = char.codePointAt(0)!;
    const isC0 = code < 0x20;
    const isC1 = code >= 0x7f && code <= 0x9f;
    const isKeptWhitespace = code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN;

    if ((isC0 || isC1) && !isKeptWhitespace) continue;
    output += char;
  }

  return output;
}

function reject(req: Request, res: Response, message: string): void {
  res.status(400).json({ success: false, error: message, requestId: req.requestId });
}

const ALLOWED_ROLES: ClientRole[] = ['user', 'assistant'];

/**
 * Validates and rebuilds the chat payload before it reaches the LLM.
 *
 * The output object is constructed field by field rather than spread from the
 * body, so unknown keys cannot ride along into the provider call. Every limit
 * here exists to cap spend: a single request used to be able to carry an
 * unbounded number of unbounded messages while counting as one rate-limit hit.
 */
export function validateChatRequest(req: Request, res: Response, next: NextFunction): void {
  const body: unknown = req.body;

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    reject(req, res, 'Request body must be a JSON object.');
    return;
  }

  const { messages, stream, temperature } = body as Record<string, unknown>;

  if (!Array.isArray(messages) || messages.length === 0) {
    reject(req, res, 'Invalid request: "messages" must be a non-empty array.');
    return;
  }

  if (messages.length > config.limits.maxMessages) {
    reject(
      req,
      res,
      `Too many messages: ${messages.length} sent, limit is ${config.limits.maxMessages}. ` +
        'Trim the conversation history before sending.'
    );
    return;
  }

  const validated: Array<{ role: ClientRole; content: string }> = [];
  let totalChars = 0;

  for (let i = 0; i < messages.length; i++) {
    const raw: unknown = messages[i];

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      reject(req, res, `Invalid request: messages[${i}] must be an object.`);
      return;
    }

    const { role, content } = raw as Record<string, unknown>;

    if (role === 'system') {
      // Called out explicitly because this used to silently replace the persona
      // prompt, turning the service into an unrestricted LLM proxy.
      reject(
        req,
        res,
        `Invalid request: messages[${i}] uses the "system" role, which is not accepted. ` +
          'The system prompt is defined server-side.'
      );
      return;
    }

    if (typeof role !== 'string' || !ALLOWED_ROLES.includes(role as ClientRole)) {
      reject(req, res, `Invalid request: messages[${i}].role must be "user" or "assistant".`);
      return;
    }

    if (typeof content !== 'string') {
      reject(req, res, `Invalid request: messages[${i}].content must be a string.`);
      return;
    }

    const cleaned = stripControlChars(content).trim();

    if (cleaned.length === 0) {
      reject(req, res, `Invalid request: messages[${i}].content must not be empty.`);
      return;
    }

    if (cleaned.length > config.limits.maxMessageChars) {
      reject(
        req,
        res,
        `Message too long: messages[${i}] is ${cleaned.length} characters, ` +
          `limit is ${config.limits.maxMessageChars}.`
      );
      return;
    }

    totalChars += cleaned.length;
    if (totalChars > config.limits.maxTotalChars) {
      reject(
        req,
        res,
        `Conversation too long: total content exceeds ${config.limits.maxTotalChars} characters.`
      );
      return;
    }

    validated.push({ role: role as ClientRole, content: cleaned });
  }

  let streamFlag = false;
  if (stream !== undefined) {
    if (typeof stream !== 'boolean') {
      reject(req, res, 'Invalid request: "stream" must be a boolean.');
      return;
    }
    streamFlag = stream;
  }

  let resolvedTemperature = config.limits.defaultTemperature;
  if (temperature !== undefined) {
    if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
      reject(req, res, 'Invalid request: "temperature" must be a finite number.');
      return;
    }
    // Clamped rather than rejected: a client asking for 5.0 gets sane output
    // instead of an error, and cannot push the model into degenerate sampling.
    resolvedTemperature = Math.min(
      config.limits.maxTemperature,
      Math.max(config.limits.minTemperature, temperature)
    );
  }

  req.validatedChat = {
    messages: validated,
    stream: streamFlag,
    temperature: resolvedTemperature,
  };

  next();
}
