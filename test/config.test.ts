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
});
