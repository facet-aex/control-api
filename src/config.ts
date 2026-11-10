import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  FACET_ENV: z.enum(["local", "preview", "production"]).default("local"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  DATABASE_URL: z.string().url(),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  FACET_OBJECT_ROOT: z.string().min(1).default(".facet-data/objects"),
  FACET_SECRET_ROOT: z.string().min(1).default(".facet-data/secrets"),
  FACET_IMPORT_MAX_DOCUMENT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(10_485_760)
    .default(5_242_880),
  FACET_IMPORT_MAX_YAML_ALIASES: z.coerce
    .number()
    .int()
    .min(0)
    .max(100)
    .default(20),
  FACET_IMPORT_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
  FACET_IMPORT_MAX_REFERENCE_DEPTH: z.coerce
    .number()
    .int()
    .positive()
    .max(64)
    .default(16),
  FACET_IMPORT_MAX_REFERENCE_COUNT: z.coerce
    .number()
    .int()
    .positive()
    .max(2_000)
    .default(256),
  FACET_IMPORT_MAX_OPERATION_COUNT: z.coerce
    .number()
    .int()
    .positive()
    .max(2_000)
    .default(500),
  FACET_IMPORT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(60_000)
    .default(10_000),
  FACET_IMPORTER_URL: z.string().url().default("http://127.0.0.1:4010"),
  FACET_IMPORT_WORKER_POLL_MS: z.coerce
    .number()
    .int()
    .min(50)
    .max(60_000)
    .default(500),
  FACET_IMPORT_WORKER_LEASE_MS: z.coerce
    .number()
    .int()
    .min(5_000)
    .max(300_000)
    .default(30_000),
  FACET_IMPORT_WORKER_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3),
  FACET_IMPORT_WORKER_RETRY_BASE_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(1_000),
  FACET_AUTH_MODE: z.enum(["local", "clerk"]).default("local"),
  CLERK_SECRET_KEY: optionalNonEmptyString,
  CLERK_JWT_KEY: optionalNonEmptyString,
  CLERK_JWT_ISSUER: optionalUrl,
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

  const importerUrl = new URL(config.FACET_IMPORTER_URL);
  const isLocalLoopback =
    config.FACET_ENV === "local" &&
    importerUrl.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(importerUrl.hostname);
  if (importerUrl.protocol !== "https:" && !isLocalLoopback) {
    throw new Error(
      "FACET_IMPORTER_URL must use HTTPS outside the local loopback environment",
    );
  }

  return config;
}
