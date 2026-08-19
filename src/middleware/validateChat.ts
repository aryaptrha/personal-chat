import type { Context, Next } from 'hono';
import { config } from '../config/env.js';
import { ClientRole } from '../types/chat.js';
import type { Env } from '../types/hono.js';

const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

function stripControlChars(input: string): string {
  return input.replace(CONTROL_CHARS_REGEX, '');
}

function reject(c: Context<Env>, message: string): Response {
  return c.json({ success: false, error: message, requestId: c.get('requestId') }, 400);
}

const ALLOWED_ROLES: ClientRole[] = ['user', 'assistant'];

export async function validateChatRequest(c: Context<Env>, next: Next): Promise<Response | void> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return reject(c, 'Malformed JSON body.');
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return reject(c, 'Request body must be a JSON object.');
  }

  const { messages, stream, temperature } = body as Record<string, unknown>;

  if (!Array.isArray(messages) || messages.length === 0) {
    return reject(c, 'Invalid request: "messages" must be a non-empty array.');
  }

  if (messages.length > config.limits.maxMessages) {
    return reject(
      c,
      `Too many messages: ${messages.length} sent, limit is ${config.limits.maxMessages}. ` +
        'Trim the conversation history before sending.'
    );
  }

  const validated: Array<{ role: ClientRole; content: string }> = [];
  let totalChars = 0;

  for (let i = 0; i < messages.length; i++) {
    const raw: unknown = messages[i];

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return reject(c, `Invalid request: messages[${i}] must be an object.`);
    }

    const { role, content } = raw as Record<string, unknown>;

    if (role === 'system') {
      return reject(
        c,
        `Invalid request: messages[${i}] uses the "system" role, which is not accepted. ` +
          'The system prompt is defined server-side.'
      );
    }

    if (typeof role !== 'string' || !ALLOWED_ROLES.includes(role as ClientRole)) {
      return reject(c, `Invalid request: messages[${i}].role must be "user" or "assistant".`);
    }

    if (typeof content !== 'string') {
      return reject(c, `Invalid request: messages[${i}].content must be a string.`);
    }

    const cleaned = stripControlChars(content).trim();

    if (cleaned.length === 0) {
      return reject(c, `Invalid request: messages[${i}].content must not be empty.`);
    }

    if (cleaned.length > config.limits.maxMessageChars) {
      return reject(
        c,
        `Message too long: messages[${i}] is ${cleaned.length} characters, ` +
          `limit is ${config.limits.maxMessageChars}.`
      );
    }

    totalChars += cleaned.length;
    if (totalChars > config.limits.maxTotalChars) {
      return reject(
        c,
        `Conversation too long: total content exceeds ${config.limits.maxTotalChars} characters.`
      );
    }

    validated.push({ role: role as ClientRole, content: cleaned });
  }

  let streamFlag = false;
  if (stream !== undefined) {
    if (typeof stream !== 'boolean') {
      return reject(c, 'Invalid request: "stream" must be a boolean.');
    }
    streamFlag = stream;
  }

  let resolvedTemperature = config.limits.defaultTemperature;
  if (temperature !== undefined) {
    if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
      return reject(c, 'Invalid request: "temperature" must be a finite number.');
    }
    resolvedTemperature = Math.min(
      config.limits.maxTemperature,
      Math.max(config.limits.minTemperature, temperature)
    );
  }

  c.set('validatedChat', {
    messages: validated,
    stream: streamFlag,
    temperature: resolvedTemperature,
  });

  await next();
}
