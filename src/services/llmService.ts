import OpenAI from 'openai';
import { config } from '../config/env.js';
import { buildSystemPrompt } from '../config/persona.js';
import { ChatMessage } from '../types/chat.js';

export class LLMService {
  private client: OpenAI | null = null;
  private lastApiKey: string = '';
  private lastBaseUrl: string = '';
  private lastTimeout: number = 0;

  private getClient(): OpenAI {
    const apiKey = config.llmApiKey || 'dummy-key';
    const baseURL = config.llmBaseUrl;
    const timeout = config.limits.llmTimeoutMs;

    if (
      !this.client ||
      this.lastApiKey !== apiKey ||
      this.lastBaseUrl !== baseURL ||
      this.lastTimeout !== timeout
    ) {
      this.client = new OpenAI({
        apiKey,
        baseURL,
        timeout,
        maxRetries: 1,
      });
      this.lastApiKey = apiKey;
      this.lastBaseUrl = baseURL;
      this.lastTimeout = timeout;
    }

    return this.client;
  }

  private prepareMessages(userMessages: ChatMessage[]): ChatMessage[] {
    const systemPrompt = buildSystemPrompt();

    const conversation = config.allowClientSystemPrompt
      ? userMessages
      : userMessages.filter((msg) => msg.role !== 'system');

    return [{ role: 'system', content: systemPrompt }, ...conversation];
  }

  private getDummyResponse(userMessages: ChatMessage[]): string {
    const lastUserMsg = userMessages.filter((m) => m.role === 'user').slice(-1)[0]?.content || 'Hello';

    return (
      `Gue denger lo bilang "${lastUserMsg}", tapi otak gue belum dipasang. ` +
      `Isi dulu LLM_API_KEY sama set USE_DUMMY_MODE=false di .env, baru gue bisa becanda beneran.`
    );
  }

  async chatCompletion(
    messages: ChatMessage[],
    temperature = config.limits.defaultTemperature,
    signal?: AbortSignal
  ) {
    if (config.useDummyMode) {
      return this.getDummyResponse(messages);
    }

    const preparedMessages = this.prepareMessages(messages);
    const client = this.getClient();

    const response = await client.chat.completions.create(
      {
        model: config.llmModel,
        messages: preparedMessages,
        temperature,
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

  async streamChatCompletion(
    messages: ChatMessage[],
    temperature = config.limits.defaultTemperature,
    signal?: AbortSignal
  ) {
    if (config.useDummyMode) {
      const fullText = this.getDummyResponse(messages);
      const words = fullText.split(' ');

      return (async function* () {
        for (const word of words) {
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
    const client = this.getClient();

    return await client.chat.completions.create(
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
