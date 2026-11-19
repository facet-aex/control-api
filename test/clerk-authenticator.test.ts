import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ClerkAuthenticator } from "../src/auth/clerk-authenticator.js";

function createTestJwt(
  privateKeyPem: string,
  subject: string,
  authorizedParty: string,
) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: subject,
      azp: authorizedParty,
      iat: now - 5,
      exp: now + 300,
    }),
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput, "utf8"),
    privateKeyPem,
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

describe("ClerkAuthenticator", () => {
  it("resolves synced users directly from the local users lookup without requiring Clerk REST calls", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const auth = new ClerkAuthenticator({
      authorizedParties: ["https://facet.example"],
      jwtKey: publicKey,
      findUserByClerkId: async (clerkId) =>
        clerkId === "user_synced"
          ? { clerkId, username: "brian-labs", status: "active" }
          : clerkId === "user_disabled"
            ? { clerkId, username: "disabled-1", status: "disabled" }
            : undefined,
    });

    const okToken = createTestJwt(
      privateKey,
      "user_synced",
      "https://facet.example",
    );
    await expect(
      auth.authenticate({ authorization: `Bearer ${okToken}` }),
    ).resolves.toEqual({
      subject: "user_synced",
      username: "brian-labs",
    });

    const disabledToken = createTestJwt(
      privateKey,
      "user_disabled",
      "https://facet.example",
    );
    await expect(
      auth.authenticate({ authorization: `Bearer ${disabledToken}` }),
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
      statusCode: 403,
    });

    const unsyncedToken = createTestJwt(
      privateKey,
      "user_missing",
      "https://facet.example",
    );
    await expect(
      auth.authenticate({ authorization: `Bearer ${unsyncedToken}` }),
    ).rejects.toMatchObject({
      code: "USERNAME_REQUIRED",
      statusCode: 409,
    });
  });
});
