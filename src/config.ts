import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  FACET_ENV: z.enum(["local", "preview", "production"]).default("local"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: z.string().url(),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  FACET_AUTH_MODE: z.enum(["local", "clerk"]).default("local"),
  CLERK_SECRET_KEY: z.string().min(1).optional(),
  CLERK_JWT_KEY: z.string().min(1).optional(),
  CLERK_JWT_ISSUER: z.string().url().optional(),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function readConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const config = environmentSchema.parse(environment);

  if (config.FACET_AUTH_MODE === "local" && config.FACET_ENV !== "local") {
    throw new Error(
      "FACET_AUTH_MODE=local is permitted only when FACET_ENV=local",
    );
  }

  if (
    config.FACET_AUTH_MODE === "clerk" &&
    !config.CLERK_SECRET_KEY &&
    !config.CLERK_JWT_KEY
  ) {
    throw new Error("Clerk auth requires CLERK_SECRET_KEY or CLERK_JWT_KEY");
  }

  return config;
}
