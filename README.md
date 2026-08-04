# Personality Chatbot Backend 🤖

A lightweight, high-performance Node.js & Express (TypeScript) backend for a custom personality AI chatbot. Powered by any OpenAI-compatible API (OpenAI, Groq, DeepSeek, Together AI, OpenRouter, Ollama, etc.) with real-time SSE streaming support and Vue.js integration.

---

## 🌟 Key Features

- 🎭 **Custom Personality Engine**: Easily define your tone, background, speaking style, constraints, and few-shot examples in `src/config/persona.ts`.
- 🔌 **Universal OpenAI Compatibility**: Works seamlessly with any LLM provider via `LLM_BASE_URL` and `LLM_API_KEY`.
- ⚡ **Real-Time Streaming**: Built-in Server-Sent Events (SSE) streaming support for smooth typing effects in Vue.js.
- 🔒 **Hardened by Default**: Server-side origin enforcement, layered rate limits, payload and output-token caps, fail-closed config, and no error detail leakage. See [Security](#-security).
- 🛡️ **Optional Strong Gates**: Shared-secret proxy and Cloudflare Turnstile support for public deployments.
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
   - `NODE_ENV`: `production` — turns the security config checks into hard startup failures
   - `LLM_API_KEY`: *(your API key)*
   - `LLM_BASE_URL`: *(your base URL)*
   - `LLM_MODEL`: *(your model name)*
   - `CORS_ORIGIN`: *(origin of your deployed Vue app, e.g. `https://yoursite.pages.dev`)*
   - `TRUST_PROXY_HOPS`: `1` — **required**, see below
6. Click **Create Web Service**. Your backend will be live with a free `https://...onrender.com` URL!

> **Why this repo ships an `.npmrc`.** npm reads `NODE_ENV=production` as an implicit
> `--omit=dev`, but the build runs in that same environment and `tsc` needs
> `typescript` and `@types/*` — which live in `devDependencies`. Without the
> `include=dev` line in [`.npmrc`](.npmrc), `npm install && npm run build` prunes them
> and the deploy dies with `TS7016: Could not find a declaration file for module
> 'express'`. Prefer a leaner production install? Delete `.npmrc` and set Render's
> build command to `npm ci --include=dev && npm run build` instead.

> **`TRUST_PROXY_HOPS` is not optional on Render.** Render terminates TLS at its own
> edge proxy, so without it `req.ip` is the proxy's address for *every* visitor —
> they all share one rate-limit bucket and the limits effectively disappear. Use `1`
> for a plain `*.onrender.com` service, or `2` if you also route through a
> Cloudflare Worker. Never set Express `trust proxy` to `true`: it makes Express read
> the client-supplied `X-Forwarded-For`, letting anyone forge a fresh IP per request.

---

## 🔐 Security

### Why CORS alone does not protect this API

A common surprise: you set `CORS_ORIGIN` to your frontend, then hit the API from
Postman and it still works.

That is CORS working as designed. **CORS is enforced by the browser, not the
server.** The server only attaches an `Access-Control-Allow-Origin` header; the
browser decides whether page JavaScript may read the response. Postman, curl, and
any script simply ignore that header. The `cors` npm package never blocks a
request — it decides whether to *add* a header and then calls `next()` either way,
so your handler runs and your LLM quota is spent regardless.

CORS stops *other websites* from using a visitor's browser against your API. It is
not authentication.

### What this backend actually enforces

| Layer | What it stops | Bypassable? |
|---|---|---|
| `originGuard` — 403 on non-allowlisted `Origin`/`Referer` | Casual direct calls, scrapers, bots | Yes, by forging the `Origin` header |
| Per-IP rate limits (window + burst + chat-specific) | Sustained abuse, quota drain | Only with many IPs |
| Payload caps (message count, length, total chars, body size) | One request costing a fortune | No |
| `MAX_OUTPUT_TOKENS` | Unbounded completion billing | No |
| Server-authoritative system prompt | Using your key as a free unrestricted LLM | No |
| `API_SHARED_SECRET` + Worker proxy | Everything not coming through your Worker | No, if the secret stays server-side |
| Cloudflare Turnstile session gate | Scripts, i.e. anything not a real browser | Not practically |

Anything shipped to a public frontend is readable in devtools, so the honest goal
for the first two rows is **raising cost and capping damage**, not making abuse
impossible. The last two rows are the ones that genuinely close the door.

### Recommended setup for a public portfolio (Cloudflare Pages + Render)

The strongest option, and it needs no login. Route the browser through your own
origin so the Render URL is never public:

```
Browser  ->  https://yoursite.pages.dev/api/*     (same origin, no CORS involved)
Worker   ->  https://your-app.onrender.com/api/*  + X-API-Key
```

1. Copy [`examples/cloudflare-worker-proxy.js`](examples/cloudflare-worker-proxy.js)
   into your Vue repo as `functions/api/[[path]].js`.
2. Generate a secret:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. Set `API_SHARED_SECRET` to it on **both** Render and Cloudflare (encrypted).
4. Set `BACKEND_URL` and `ALLOWED_ORIGIN` on Cloudflare, and `TRUST_PROXY_HOPS=2`
   on Render (the Worker adds a hop).
5. Point your Vue app at `/api/chat` instead of the Render URL.

The secret never reaches the browser, and Render now rejects every request that
did not come through your Worker.

### Optional: Cloudflare Turnstile

Set `TURNSTILE_SECRET_KEY` and `/api/chat` starts requiring a session token:

1. Frontend solves Turnstile, then `POST /api/session` with `{ turnstileToken }`.
2. Backend verifies with Cloudflare and returns a signed `sessionToken`.
3. Frontend sends `X-Session-Token: <token>` on each `/api/chat` call.

Verification happens once per session rather than per message, because Turnstile
tokens are single-use and expire in minutes — challenging on every turn would make
the chat unusable. `GET /api/config` reports `turnstileRequired` so the frontend
can render the widget only when the backend expects it.

Set `SESSION_TOKEN_SECRET` too, or tokens are signed with a per-boot random key and
every Render restart invalidates active sessions.

### Note on `messages[].role`

Client-supplied `system` messages are rejected with a 400. Previously a caller
could send one and replace the persona prompt entirely, turning the service into an
open, unrestricted LLM proxy billed to your API key. The system prompt is now built
server-side and always prepended. `ALLOW_CLIENT_SYSTEM_PROMPT` exists for local
prompt experiments only and blocks production startup.

---

## 📁 Project Structure

```
.
├── package.json
├── tsconfig.json
├── .npmrc                          # Keeps build-time deps installable under NODE_ENV=production
├── .env.example
├── examples/
│   └── cloudflare-worker-proxy.js  # Keeps the shared secret out of the browser
├── src/
│   ├── index.ts                    # Server setup, trust proxy, CORS, guard order
│   ├── config/
│   │   ├── env.ts                  # Env manager + fail-closed startup validation
│   │   └── persona.ts              # Persona, system prompt, public projection
│   ├── middleware/
│   │   ├── errorHandler.ts         # Generic errors + 404, no internal detail leaks
│   │   ├── originGuard.ts          # Server-side origin enforcement (403)
│   │   ├── rateLimiter.ts          # Window, burst, chat, and session limiters
│   │   ├── securityHeaders.ts      # Request ids, security headers, no-store
│   │   ├── sharedSecret.ts         # Optional X-API-Key gate for a proxy caller
│   │   ├── turnstile.ts            # Optional Turnstile + session requirement
│   │   └── validateChat.ts         # Payload validation and cost caps
│   ├── routes/
│   │   └── chat.ts                 # /api/chat, /api/persona, /api/config, /api/session
│   ├── services/
│   │   ├── llmService.ts           # OpenAI SDK wrapper, authoritative system prompt
│   │   └── sessionToken.ts         # Signed stateless session tokens
│   └── types/
│       ├── chat.ts                 # TypeScript interfaces
│       └── express.d.ts            # Request augmentation
└── README.md
```
