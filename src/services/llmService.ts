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
    });
  }

  /**
   * Prepares messages by injecting the system personality prompt.
   */
  private prepareMessages(userMessages: ChatMessage[]): ChatMessage[] {
    const systemPrompt = buildSystemPrompt();
    const hasSystemMessage = userMessages.some((msg) => msg.role === 'system');

    if (hasSystemMessage) {
      return userMessages;
    }

    return [
      { role: 'system', content: systemPrompt },
      ...userMessages,
    ];
  }

  /**
   * Generates a contextual dummy response for testing without LLM API calls.
   */
  private getDummyResponse(userMessages: ChatMessage[]): string {
    const lastUserMsg = userMessages.filter((m) => m.role === 'user').slice(-1)[0]?.content || 'Hello';

    return (
      `Halo! Saya Akbar (bot digital twin versi dummy 🤖).\n\n` +
      `Pesan kamu: "${lastUserMsg}" telah diterima.\n\n` +
      `Backend Express + TypeScript berjalan sempurna! Ini adalah respon simulasi dummy mode. ` +
      `Untuk menghubungkan ke LLM asli, atur \`LLM_API_KEY\` dan \`USE_DUMMY_MODE=false\` pada file \`.env\`.`
    );
  }

  /**
   * Complete chat request (non-streaming)
   */
  async chatCompletion(messages: ChatMessage[], temperature = 0.7) {
    if (config.useDummyMode) {
      return this.getDummyResponse(messages);
    }

    const preparedMessages = this.prepareMessages(messages);

    const response = await this.client.chat.completions.create({
      model: config.llmModel,
      messages: preparedMessages,
      temperature,
    });

    return response.choices[0]?.message?.content || '';
  }

  /**
   * Stream chat completion (Server-Sent Events)
   */
  async streamChatCompletion(messages: ChatMessage[], temperature = 0.7) {
    if (config.useDummyMode) {
      const fullText = this.getDummyResponse(messages);
      const words = fullText.split(' ');

      // Create an async generator that simulates OpenAI SSE stream format
      return (async function* () {
        for (const word of words) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          yield {
            choices: [
              {
                delta: { content: word + ' ' },
              },
            ],
          };
        }
      })();
    }

    const preparedMessages = this.prepareMessages(messages);

    return await this.client.chat.completions.create({
      model: config.llmModel,
      messages: preparedMessages,
      temperature,
      stream: true,
    });
  }
}

export const llmService = new LLMService();
