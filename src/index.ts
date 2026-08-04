import express from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import { chatRouter } from './routes/chat.js';

const app = express();

// Enable CORS for Vue.js frontend
app.use(
  cors({
    origin: config.corsOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json());

// Health Check Endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api', chatRouter);

// Start server
app.listen(config.port, () => {
  console.log(`🚀 Chatbot backend running on http://localhost:${config.port}`);
  console.log(`🎯 Configured LLM Base URL: ${config.llmBaseUrl}`);
  console.log(`🤖 Configured LLM Model: ${config.llmModel}`);
});
