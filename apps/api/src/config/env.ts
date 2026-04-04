import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3001),

  // Database
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // Auth0
  AUTH0_DOMAIN: z.string().min(1),
  AUTH0_AUDIENCE: z.string().min(1),
  AUTH0_CLIENT_ID: z.string().min(1),
  AUTH0_M2M_CLIENT_ID: z.string().min(1),
  AUTH0_M2M_CLIENT_SECRET: z.string().min(1),
  AUTH0_TOKEN_VAULT_BASE_URL: z.string().optional(),

  // Agent M2M
  AGENT_AUTH0_CLIENT_ID: z.string().optional(),
  AGENT_AUTH0_CLIENT_SECRET: z.string().optional(),

  // Frontend
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  // Backend (self-reference for OAuth redirect_uri)
  API_BASE_URL: z.string().default('http://localhost:3001'),

  // Web Push
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),

  // AI
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const env = validateEnv();
