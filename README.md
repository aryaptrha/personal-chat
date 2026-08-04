# Personality Chatbot Backend 🤖

A lightweight, high-performance Node.js & Express (TypeScript) backend for a custom personality AI chatbot. Powered by any OpenAI-compatible API (OpenAI, Groq, DeepSeek, Together AI, OpenRouter, Ollama, etc.) with real-time SSE streaming support and Vue.js integration.

---

## 🌟 Key Features

- 🎭 **Custom Personality Engine**: Easily define your tone, background, speaking style, constraints, and few-shot examples in `src/config/persona.ts`.
- 🔌 **Universal OpenAI Compatibility**: Works seamlessly with any LLM provider via `LLM_BASE_URL` and `LLM_API_KEY`.
- ⚡ **Real-Time Streaming**: Built-in Server-Sent Events (SSE) streaming support for smooth typing effects in Vue.js.
- 🔒 **CORS Ready**: Pre-configured CORS support for easy connection with your Vue.js frontend.
- 🚀 **Free Tier Hosting Friendly**: Optimized for zero-cost deployment on Render, Vercel, or Koyeb.

---

## 🚀 Quick Start (Local Development)

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Update your `.env` file with your details:

```ini
PORT=3000
LLM_API_KEY=your_actual_api_key
LLM_BASE_URL=https://api.openai.com/v1  # Or https://api.groq.com/openai/v1, https://api.deepseek.com/v1, etc.
LLM_MODEL=gpt-4o-mini                    # Or llama-3.1-70b-versatile, deepseek-chat, etc.
CORS_ORIGIN=http://localhost:5173        # Your Vue dev server address
```

### 3. Run Development Server

```bash
npm run dev
```

The server will launch on `http://localhost:3000`. Test the health check at `http://localhost:3000/health`.

---

## 🎭 Customizing Your Personality

Open [`src/config/persona.ts`](file:///C:/Users/developer.support2/source/repos/arya/src/config/persona.ts) and edit the `defaultPersona` object:

```typescript
export const defaultPersona: PersonaProfile = {
  name: "Your Name / Persona Name",
  tagline: "Short tagline or sub-heading",
  background: "Brief summary of who you are and what you do...",
  traits: [
    "Friendly & encouraging",
    "Direct and analytical",
    // Add your traits here
  ],
  toneAndStyle: [
    "Uses modern slang / concise explanations",
    "Prefers bullet points for complex answers",
  ],
  guidelines: [
    "Always maintain your identity as [Your Name]",
    "If asked about personal details not provided, politely pivot back to chat",
  ],
  examples: [
    {
      user: "What's your favorite coding stack?",
      assistant: "Vue.js on the frontend and Node/TypeScript on the backend—clean, fast, and productive!"
    }
  ]
};
```

---

## 🌐 Connecting with Vue.js (Frontend Integration)

### Example 1: Standard Fetch (Non-Streaming)

```javascript
async function sendMessage(userMessage) {
  const response = await fetch('http://localhost:3000/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'user', content: userMessage }
      ]
    })
  });
  
  const data = await response.json();
  console.log('AI Response:', data.reply);
}
```

### Example 2: Real-time SSE Streaming (Vue 3 Composition API)

```vue
<script setup>
import { ref } from 'vue';

const messages = ref([]);
const userInput = ref('');
const isThinking = ref(false);

async function sendStreamingMessage() {
  if (!userInput.value.trim()) return;

  const userText = userInput.value;
  messages.value.push({ role: 'user', content: userText });
  userInput.value = '';

  // Add placeholder for assistant streaming response
  const assistantMsg = ref({ role: 'assistant', content: '' });
  messages.value.push(assistantMsg.value);
  isThinking.value = true;

  try {
    const response = await fetch('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: messages.value.slice(0, -1), // Send full history excluding empty placeholder
        stream: true
      })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.replace('data: ', '').trim();
          if (dataStr === '[DONE]') break;

          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.content) {
              assistantMsg.value.content += parsed.content;
            }
          } catch (e) {
            // Ignore partial line parses
          }
        }
      }
    }
  } catch (err) {
    console.error('Streaming error:', err);
  } finally {
    isThinking.value = false;
  }
}
</script>
```

---

## ☁️ Free Tier Hosting Recommendations

Here are the top free tier options for deploying this backend:

| Host | Free Plan Features | Best Used For |
|---|---|---|
| **Render.com** | 750 free hours/month, automatic HTTPS, Git push auto-deploy | **Recommended** for standard Express server setups |
| **Vercel** | Free Serverless functions (100 GB-hrs, 100k requests/mo) | Great if deploying frontend + backend under one ecosystem |
| **Koyeb** | 1 Nano instance free forever | Docker / Node apps without sleep delays |

### Option A: Deploying on Render (Recommended)

1. Push your repository to **GitHub** / **GitLab**.
2. Log in to [Render.com](https://render.com) and click **New +** -> **Web Service**.
3. Connect your repository.
4. Set the following build options:
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
5. Under **Environment Variables**, add:
   - `LLM_API_KEY`: *(your API key)*
   - `LLM_BASE_URL`: *(your base URL)*
   - `LLM_MODEL`: *(your model name)*
   - `CORS_ORIGIN`: *(URL of your deployed Vue app)*
6. Click **Create Web Service**. Your backend will be live with a free `https://...onrender.com` URL!

---

## 📁 Project Structure

```
.
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts             # Express Server Initialization & CORS
│   ├── config/
│   │   ├── env.ts           # Environment variables manager
│   │   └── persona.ts       # Personality Profile & System Prompt Builder
│   ├── routes/
│   │   └── chat.ts          # /api/chat & /api/persona API endpoints
│   ├── services/
│   │   └── llmService.ts    # OpenAI SDK client wrapper
│   └── types/
│       └── chat.ts          # TypeScript interfaces
└── README.md
```
