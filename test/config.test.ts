import { describe, expect, it } from "vitest";

import { readConfig } from "../src/config.js";

describe("authentication configuration", () => {
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
    });

    expect(config.CLERK_SECRET_KEY).toBeUndefined();
    expect(config.CLERK_JWT_KEY).toBeUndefined();
    expect(config.CLERK_JWT_ISSUER).toBeUndefined();
    expect(config.FACET_OBJECT_ROOT).toBe(".facet-data/objects");
    expect(config.FACET_IMPORT_MAX_DOCUMENT_BYTES).toBe(5_242_880);
    expect(config.FACET_IMPORT_MAX_REDIRECTS).toBe(3);
    expect(config.FACET_IMPORT_TIMEOUT_MS).toBe(10_000);
  });
});
