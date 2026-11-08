import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("health endpoints", () => {
  it("reports liveness without touching the database", async () => {
    const app = await buildApp({
      checkDatabase: async () => undefined,
      environment: "local",
      webOrigin: "http://localhost:3000",
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      service: "control-api",
      status: "ok",
    });
  });

  it("fails readiness closed when PostgreSQL is unavailable", async () => {
    const app = await buildApp({
      checkDatabase: async () => {
        throw new Error("database unavailable");
      },
      environment: "local",
      webOrigin: "http://localhost:3000",
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      service: "control-api",
      status: "degraded",
    });
  });
});
