import OpenAI from "openai";

if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY === 'your_key_here') {
  console.error("❌ Please set OPENROUTER_API_KEY in agent/.env before running.");
  process.exit(1);
}

export const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://agentguardian.com", 
    "X-Title": "Agent Guardian",
  }
});

export const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
