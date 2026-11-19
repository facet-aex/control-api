import { verifyWebhook } from "@clerk/backend/webhooks";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { AppError } from "../errors.js";
import { isValidUsername } from "../identifiers.js";
import { extractVerifiedClerkEvmWallet } from "./clerk-wallet.js";
import type {
  ClerkWebhookUserEvent,
  ProviderStore,
} from "../providers/provider-types.js";

export interface ClerkWebhookRouteDependencies {
  signingSecret?: string | undefined;
  store: Pick<ProviderStore, "applyClerkWebhook">;
}

const webhookWeb3WalletSchema = z.object({
  id: z.string().optional(),
  web3_wallet: z.string().optional(),
  verification: z
    .object({ status: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

const userMutationSchema = z.object({
  id: z.string().min(1),
  username: z.string().nullable().optional(),
  primary_web3_wallet_id: z.string().nullable().optional(),
  web3_wallets: z.array(webhookWeb3WalletSchema).optional(),
});

const userDeletedSchema = z.object({
  id: z.string().min(1),
  deleted: z.boolean().optional(),
});

export async function registerClerkWebhookRoutes(
  app: FastifyInstance,
  dependencies: ClerkWebhookRouteDependencies,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.post("/v1/webhooks/clerk", async (request, reply) => {
      if (!dependencies.signingSecret) {
        throw new AppError(
          "CLERK_WEBHOOK_UNCONFIGURED",
          "Clerk webhook signing secret is not configured.",
          503,
        );
      }

      const rawBody = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.from(
            typeof request.body === "string"
              ? request.body
              : JSON.stringify(request.body ?? ""),
            "utf8",
          );
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(","));
      }
      const webRequest = new Request("https://facet.local/v1/webhooks/clerk", {
        method: "POST",
        headers,
        body: new Uint8Array(rawBody),
      });

      let verifiedEvent;
      try {
        verifiedEvent = await verifyWebhook(webRequest, {
          signingSecret: dependencies.signingSecret,
        });
      } catch {
        throw new AppError(
          "INVALID_WEBHOOK_SIGNATURE",
          "Webhook signature verification failed.",
          401,
        );
      }

      let mapped: ClerkWebhookUserEvent | null = null;
      if (
        verifiedEvent.type === "user.created" ||
        verifiedEvent.type === "user.updated"
      ) {
        const parsed = userMutationSchema.parse(verifiedEvent.data);
        const username = parsed.username?.trim();
        if (!username || !isValidUsername(username)) {
          throw new AppError(
            "INVALID_USERNAME",
            "Clerk webhook user must have an 8-16 character lowercase hyphenated kebab-case username.",
            422,
          );
        }
        const walletAddress = extractVerifiedClerkEvmWallet({
          primaryId: parsed.primary_web3_wallet_id,
          wallets: parsed.web3_wallets,
        });
        mapped = {
          type: verifiedEvent.type,
          data: {
            id: parsed.id,
            username,
            ...(walletAddress ? { walletAddress } : {}),
          },
        };
      } else if (verifiedEvent.type === "user.deleted") {
        const parsed = userDeletedSchema.parse(verifiedEvent.data);
        mapped = {
          type: "user.deleted",
          data: { id: parsed.id, deleted: parsed.deleted ?? true },
        };
      }

      if (!mapped) {
        return reply.code(200).send({ received: true, ignored: true });
      }

      await dependencies.store.applyClerkWebhook(mapped, request.id);
      return reply.code(200).send({ received: true });
    });
  });
}
