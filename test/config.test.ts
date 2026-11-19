import { describe, expect, it } from "vitest";

import { readConfig } from "../src/config.js";

describe("authentication configuration", () => {
  it("requires an internal executor token, Clerk webhook secret, and fixed Docker service URL in production", () => {
    const base = {
      FACET_ENV: "production",
      FACET_AUTH_MODE: "clerk",
      CLERK_SECRET_KEY: "test-key",
      CLERK_WEBHOOK_SIGNING_SECRET: "whsec_testsecret",
      DATABASE_URL: "postgresql://user:password@localhost:5432/facet",
      FACET_IMPORTER_URL: "http://openapi-importer:4010",
      FACET_IMPORTER_ALLOW_PRIVATE_HTTP: "1",
    };
    expect(() => readConfig(base)).toThrow("FACET_EXECUTOR_TOKEN");
    expect(() =>
      readConfig({
        ...base,
        FACET_EXECUTOR_TOKEN: "a".repeat(32),
        FACET_EXECUTOR_URL: "http://evil.example:4030",
      }),
    ).toThrow("FACET_EXECUTOR_URL");
    const valid = readConfig({
      ...base,
      FACET_EXECUTOR_TOKEN: "a".repeat(32),
      FACET_EXECUTOR_URL: "http://executor:4030",
    });
    expect(valid.FACET_EXECUTOR_URL).toBe("http://executor:4030");
    expect(valid.CLERK_WEBHOOK_SIGNING_SECRET).toBe("whsec_testsecret");
  });

  it("rejects local header auth outside the local environment", () => {
    expect(() =>
      readConfig({
        FACET_ENV: "preview",
        FACET_AUTH_MODE: "local",
        DATABASE_URL: "postgresql://user:password@localhost:5432/facet",
      }),
    ).toThrow("FACET_AUTH_MODE=local is permitted only");
  });

  it("requires Clerk verification material in Clerk mode", () => {
    expect(() =>
      readConfig({
        FACET_ENV: "preview",
        FACET_AUTH_MODE: "clerk",
        DATABASE_URL: "postgresql://user:password@localhost:5432/facet",
      }),
    ).toThrow("Clerk auth requires");
  });

  it("treats empty optional Clerk variables as unset", () => {
    const config = readConfig({
      FACET_ENV: "local",
      FACET_AUTH_MODE: "local",
      DATABASE_URL: "postgresql://facet:facet@localhost:5432/facet",
      CLERK_SECRET_KEY: "",
      CLERK_JWT_KEY: "",
      CLERK_JWT_ISSUER: "",
      CLERK_WEBHOOK_SIGNING_SECRET: "",
    });

    expect(config.CLERK_SECRET_KEY).toBeUndefined();
    expect(config.CLERK_JWT_KEY).toBeUndefined();
    expect(config.CLERK_JWT_ISSUER).toBeUndefined();
    expect(config.CLERK_WEBHOOK_SIGNING_SECRET).toBeUndefined();
    expect(config.FACET_OBJECT_ROOT).toBe(".facet-data/objects");
    expect(config.FACET_SECRET_ROOT).toBe(".facet-data/secrets");
    expect(config.FACET_IMPORT_MAX_DOCUMENT_BYTES).toBe(5_242_880);
    expect(config.FACET_IMPORT_MAX_REDIRECTS).toBe(3);
    expect(config.FACET_IMPORT_TIMEOUT_MS).toBe(10_000);
    expect(config.FACET_IMPORTER_URL).toBe("http://127.0.0.1:4010");
    expect(config.FACET_IMPORT_WORKER_LEASE_MS).toBe(30_000);
  });

  it("rejects plaintext importer traffic outside local loopback", () => {
    expect(() =>
      readConfig({
        FACET_ENV: "preview",
        FACET_AUTH_MODE: "clerk",
        CLERK_SECRET_KEY: "test-key",
        DATABASE_URL: "postgresql://user:password@localhost:5432/facet",
        FACET_IMPORTER_URL: "http://importer.internal:4010",
      }),
    ).toThrow("FACET_IMPORTER_URL must use HTTPS");
  });

  it("allows the exact Docker importer URL only with a production opt-in", () => {
    const environment = {
      FACET_ENV: "production",
      FACET_AUTH_MODE: "clerk",
      CLERK_SECRET_KEY: "test-key",
      DATABASE_URL: "postgresql://user:password@localhost:5432/facet",
      FACET_IMPORTER_URL: "http://openapi-importer:4010",
      FACET_EXECUTOR_URL: "http://executor:4030",
      FACET_EXECUTOR_TOKEN: "a".repeat(32),
    };

    expect(() => readConfig(environment)).toThrow(
      "FACET_IMPORTER_URL must use HTTPS",
    );
    expect(
      readConfig({
        ...environment,
        FACET_IMPORTER_ALLOW_PRIVATE_HTTP: "1",
      }).FACET_IMPORTER_URL,
    ).toBe("http://openapi-importer:4010");
  });

  it.each([
    "http://importer.internal:4010",
    "http://openapi-importer.evil:4010",
    "http://openapi-importer:4011",
    "http://openapi-importer:4010/other",
    "http://user:pass@openapi-importer:4010",
  ])("rejects other plaintext importer URLs even with opt-in: %s", (url) => {
    expect(() =>
      readConfig({
        FACET_ENV: "production",
        FACET_AUTH_MODE: "clerk",
        CLERK_SECRET_KEY: "test-key",
        DATABASE_URL: "postgresql://user:password@localhost:5432/facet",
        FACET_IMPORTER_URL: url,
        FACET_IMPORTER_ALLOW_PRIVATE_HTTP: "1",
      }),
    ).toThrow("FACET_IMPORTER_URL must use HTTPS");
  });
});
