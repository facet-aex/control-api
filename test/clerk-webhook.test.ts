import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

const SIGNING_SECRET = `whsec_${randomBytes(32).toString("base64")}`;

function signedHeaders(rawBody: string, id = "msg_test_1") {
  const timestamp = new Date();
  const wh = new Webhook(SIGNING_SECRET);
  const signature = wh.sign(id, timestamp, rawBody);
  return {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
    "svix-signature": signature,
  };
}

let app: FastifyInstance;
let store: InMemoryProviderStore;

beforeEach(async () => {
  store = new InMemoryProviderStore();
  app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "local",
    webOrigin: "http://localhost:3000",
    clerkWebhook: {
      signingSecret: SIGNING_SECRET,
      store,
    },
  });
});

afterEach(async () => {
  await app.close();
});

describe("Clerk webhook user synchronization", () => {
  it("rejects missing or forged Svix signatures with 401", async () => {
    const rawBody = JSON.stringify({
      type: "user.created",
      data: { id: "user_123", username: "brian-labs" },
    });

    const missing = await app.inject({
      method: "POST",
      url: "/v1/webhooks/clerk",
      headers: { "content-type": "application/json" },
      payload: rawBody,
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({
      error: { code: "INVALID_WEBHOOK_SIGNATURE" },
    });

    const forged = await app.inject({
      method: "POST",
      url: "/v1/webhooks/clerk",
      headers: {
        ...signedHeaders(rawBody, "msg_forged"),
        "svix-signature": "v1,invalidsignature==",
      },
      payload: rawBody,
    });
    expect(forged.statusCode).toBe(401);
  });

  it("rejects user.created and user.updated when username violates 8-16 kebab-case with 422", async () => {
    for (const badUsername of [
      "alice",
      "way-too-long-username",
      "Bad_Case",
      "pg30_cs3244",
      "double--dash",
      null,
    ]) {
      const rawBody = JSON.stringify({
        type: "user.created",
        data: { id: "user_bad", username: badUsername },
      });
      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks/clerk",
        headers: signedHeaders(rawBody, `msg_bad_${String(badUsername)}`),
        payload: rawBody,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        error: { code: "INVALID_USERNAME" },
      });
    }
  });

  it("creates, renames, and soft-disables users transactionally while preserving internal user ID", async () => {
    const createdBody = JSON.stringify({
      type: "user.created",
      data: { id: "user_abc", username: "brian-labs" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/webhooks/clerk",
      headers: signedHeaders(createdBody, "msg_create_1"),
      payload: createdBody,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ received: true });

    const initialUser = await store.findUserByClerkId("user_abc");
    expect(initialUser).toBeDefined();
    expect(initialUser?.username).toBe("brian-labs");
    expect(initialUser?.status).toBe("active");

    const updatedBody = JSON.stringify({
      type: "user.updated",
      data: { id: "user_abc", username: "brian-studio" },
    });
    const updated = await app.inject({
      method: "POST",
      url: "/v1/webhooks/clerk",
      headers: signedHeaders(updatedBody, "msg_update_1"),
      payload: updatedBody,
    });
    expect(updated.statusCode).toBe(200);

    const renamedUser = await store.findUserByClerkId("user_abc");
    expect(renamedUser?.id).toBe(initialUser?.id);
    expect(renamedUser?.username).toBe("brian-studio");
    expect(await store.findUserByUsername("brian-labs")).toBeUndefined();

    const deletedBody = JSON.stringify({
      type: "user.deleted",
      data: { id: "user_abc", deleted: true },
    });
    const deleted = await app.inject({
      method: "POST",
      url: "/v1/webhooks/clerk",
      headers: signedHeaders(deletedBody, "msg_delete_1"),
      payload: deletedBody,
    });
    expect(deleted.statusCode).toBe(200);

    const disabledUser = await store.findUserByClerkId("user_abc");
    expect(disabledUser?.id).toBe(initialUser?.id);
    expect(disabledUser?.status).toBe("disabled");
  });

  it("rejects conflicting username collisions on webhook sync with 409", async () => {
    const firstBody = JSON.stringify({
      type: "user.created",
      data: { id: "user_one", username: "shared-name" },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/webhooks/clerk",
          headers: signedHeaders(firstBody, "msg_one"),
          payload: firstBody,
        })
      ).statusCode,
    ).toBe(200);

    const secondBody = JSON.stringify({
      type: "user.created",
      data: { id: "user_two", username: "shared-name" },
    });
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/webhooks/clerk",
      headers: signedHeaders(secondBody, "msg_two"),
      payload: secondBody,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "RESOURCE_CONFLICT" },
    });
  });
});
