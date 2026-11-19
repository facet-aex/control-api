import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

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

  it("skips Clerk REST lookup when synced user already has a wallet and backfills when missing or unsynced", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const getUser = vi.fn(async (clerkId: string) => {
      if (clerkId === "user_outage") {
        throw new Error("Clerk transient error");
      }
      if (clerkId === "user_synced_no_wallet") {
        return {
          username: "synced-no-wal",
          primaryWeb3WalletId: "w3w_prim",
          web3Wallets: [
            {
              id: "w3w_unverified",
              web3Wallet: "0x1111111111111111111111111111111111111111",
              verification: { status: "unverified" },
            },
            {
              id: "w3w_solana",
              web3Wallet: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
              verification: { status: "verified" },
            },
            {
              id: "w3w_prim",
              web3Wallet: "0x9265c1c87fc5fb3c72dc68b4d3a005de1e22c3cf",
              verification: { status: "verified" },
            },
          ],
        };
      }
      return {
        username: "unsynced-user",
        primaryWeb3WalletId: "w3w_1",
        web3Wallets: [
          {
            id: "w3w_1",
            web3Wallet: "0x5189c4c1a14dc1a6845425b6c44d2b40c0b4f39b",
            verification: { status: "verified" },
          },
        ],
      };
    });

    const auth = new ClerkAuthenticator({
      authorizedParties: ["https://facet.example"],
      jwtKey: publicKey,
      findUserByClerkId: async (clerkId) => {
        if (clerkId === "user_with_wallet") {
          return {
            clerkId,
            username: "wallet-ready",
            walletAddress: "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf",
            status: "active",
          };
        }
        if (clerkId === "user_synced_no_wallet") {
          return {
            clerkId,
            username: "synced-no-wal",
            walletAddress: null,
            status: "active",
          };
        }
        if (clerkId === "user_outage") {
          return {
            clerkId,
            username: "outage-user",
            walletAddress: null,
            status: "active",
          };
        }
        return undefined;
      },
      getUser,
    });

    const readyToken = createTestJwt(
      privateKey,
      "user_with_wallet",
      "https://facet.example",
    );
    await expect(
      auth.authenticate({ authorization: `Bearer ${readyToken}` }),
    ).resolves.toEqual({
      subject: "user_with_wallet",
      username: "wallet-ready",
    });
    expect(getUser).not.toHaveBeenCalled();

    const backfillToken = createTestJwt(
      privateKey,
      "user_synced_no_wallet",
      "https://facet.example",
    );
    await expect(
      auth.authenticate({ authorization: `Bearer ${backfillToken}` }),
    ).resolves.toEqual({
      subject: "user_synced_no_wallet",
      username: "synced-no-wal",
      walletAddress: "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf",
    });

    const outageToken = createTestJwt(
      privateKey,
      "user_outage",
      "https://facet.example",
    );
    await expect(
      auth.authenticate({ authorization: `Bearer ${outageToken}` }),
    ).resolves.toEqual({
      subject: "user_outage",
      username: "outage-user",
    });

    const fallbackToken = createTestJwt(
      privateKey,
      "user_new_oauth",
      "https://facet.example",
    );
    await expect(
      auth.authenticate({ authorization: `Bearer ${fallbackToken}` }),
    ).resolves.toEqual({
      subject: "user_new_oauth",
      username: "unsynced-user",
      walletAddress: "0x5189c4C1a14Dc1a6845425B6C44D2B40c0b4f39B",
    });
  });
});
