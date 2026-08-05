import OpenAI from 'openai';
import { config } from '../config/env.js';
import { buildSystemPrompt } from '../config/persona.js';
import { ChatMessage } from '../types/chat.js';

export class LLMService {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: config.llmApiKey || 'dummy-key',
      baseURL: config.llmBaseUrl,
      timeout: config.limits.llmTimeoutMs,
      maxRetries: 1,
    });
  }

  /**
   * Prepares messages by injecting the system personality prompt.
   *
   * The server-side prompt is authoritative and always prepended. Any
   * client-supplied `system` message is dropped, because honouring one let a
   * caller replace the persona and its guardrails wholesale — effectively an
   * open, unrestricted LLM proxy billed to this project's API key.
   *
   * `validateChatRequest` already rejects the `system` role at the edge; this is
   * the defence-in-depth copy, so the service is safe to call from anywhere.
   */
  private prepareMessages(userMessages: ChatMessage[]): ChatMessage[] {
    const systemPrompt = buildSystemPrompt();

    const conversation = config.allowClientSystemPrompt
      ? userMessages
      : userMessages.filter((msg) => msg.role !== 'system');

    return [{ role: 'system', content: systemPrompt }, ...conversation];
  }

  /**
   * Generates a contextual dummy response for testing without LLM API calls.
   */
  private getDummyResponse(userMessages: ChatMessage[]): string {
    const lastUserMsg = userMessages.filter((m) => m.role === 'user').slice(-1)[0]?.content || 'Hello';

    return (
      `Gue denger lo bilang "${lastUserMsg}", tapi otak gue belum dipasang. ` +
      `Isi dulu LLM_API_KEY sama set USE_DUMMY_MODE=false di .env, baru gue bisa becanda beneran.`
    );
  }

  /**
   * Complete chat request (non-streaming)
   */
  async chatCompletion(
    messages: ChatMessage[],
    temperature = config.limits.defaultTemperature,
    signal?: AbortSignal
  ) {
    if (config.useDummyMode) {
      return this.getDummyResponse(messages);
    }

    const preparedMessages = this.prepareMessages(messages);

    const response = await this.client.chat.completions.create(
      {
        model: config.llmModel,
        messages: preparedMessages,
        temperature,
        // Hard ceiling on output size. Without it a single request could bill an
        // unbounded completion.
        max_tokens: config.limits.maxOutputTokens,
      },
      { signal }
    );

    const firstChoice = response.choices[0];
    if (firstChoice?.finish_reason === 'length') {
      console.warn(
        `[LLM] Response truncated: hit MAX_OUTPUT_TOKENS limit (${config.limits.maxOutputTokens} tokens).`
      );
    }

    return firstChoice?.message?.content || '';
  }

  /**
   * Stream chat completion (Server-Sent Events)
   */
  async streamChatCompletion(
    messages: ChatMessage[],
    temperature = config.limits.defaultTemperature,
    signal?: AbortSignal
  ) {
    if (config.useDummyMode) {
      const fullText = this.getDummyResponse(messages);
      const words = fullText.split(' ');

      // Create an async generator that simulates OpenAI SSE stream format
      return (async function* () {
        for (const word of words) {
          // Stop as soon as the client goes away, matching the real stream.
          if (signal?.aborted) return;
          await new Promise((resolve) => setTimeout(resolve, 40));
            yield {
              choices: [
                {
                  delta: { content: word + ' ' },
                  finish_reason: null as string | null,
                },
              ],
            };
        }
      })();
    }

    const preparedMessages = this.prepareMessages(messages);

    return await this.client.chat.completions.create(
      {
        model: config.llmModel,
        messages: preparedMessages,
        temperature,
        max_tokens: config.limits.maxOutputTokens,
        stream: true,
      },
      { signal }
    );
  }
}

export const llmService = new LLMService();
