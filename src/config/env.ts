import dotenv from 'dotenv';

dotenv.config();

const rawBaseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
// Automatically ensure OpenAI base URL ends with /v1 if missing
const normalizedBaseUrl = rawBaseUrl.endsWith('/v1') || rawBaseUrl.endsWith('/v1/') 
  ? rawBaseUrl 
  : `${rawBaseUrl.replace(/\/$/, '')}/v1`;

export const config = {
  port: process.env.PORT || 3000,
  llmApiKey: process.env.LLM_API_KEY || '',
  llmBaseUrl: normalizedBaseUrl,
  llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',
  corsOrigin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
  useDummyMode: process.env.USE_DUMMY_MODE === 'true' || !process.env.LLM_API_KEY,
  rateLimitWindowMs: (parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES || '15', 10)) * 60 * 1000,
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '20', 10),
};

if (config.useDummyMode) {
  console.log('💡 Running in DUMMY MODE (mock AI responses enabled). Set USE_DUMMY_MODE=false and provide LLM_API_KEY for real LLM integration.');
}

