import { AppError } from "../errors.js";
import type { AuthenticatedIdentity } from "../auth/types.js";
import { isValidUsername } from "../identifiers.js";
import {
  newWalletLinkChallenge,
  verifyWalletLinkSignature,
} from "./wallet-link.js";
import type {
  CurrentUser,
  ProviderStore,
  PublicProvider,
  UserRecord,
} from "./provider-types.js";

function toCurrentUser(user: UserRecord): CurrentUser {
  return {
    clerkId: user.clerkId,
    username: user.username,
    walletAddress: user.walletAddress,
    walletVerifiedAt: user.walletVerifiedAt?.toISOString() ?? null,
    status: user.status,
  };
}

function toPublicProvider(user: UserRecord): PublicProvider {
  return {
    provider: user.username,
    walletAddress: user.walletAddress,
    walletVerifiedAt: user.walletVerifiedAt?.toISOString() ?? null,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export class ProviderService {
  constructor(
    private readonly store: ProviderStore,
    private readonly options: {
      environment: "local" | "preview" | "production";
      challengeDomain?: string;
      now?: () => Date;
    },
  ) {}

  private async requireSelf(
    identity: AuthenticatedIdentity,
    provider: string,
  ): Promise<UserRecord> {
    if (!isValidUsername(provider)) {
      throw new AppError(
        "INPUT_INVALID",
        "Provider username must be 8-16 character lowercase kebab-case.",
        400,
      );
    }
    const actor = await this.store.upsertUser(identity);
    if (actor.status !== "active") {
      throw new AppError(
        "AUTHORIZATION_DENIED",
        "This FACET user is disabled.",
        403,
      );
    }
    if (actor.username !== provider) {
      throw new AppError(
        "AUTHORIZATION_DENIED",
        "Only the owning provider account may manage its payout wallet.",
        403,
      );
    }
    return actor;
  }

  async getCurrentUser(identity: AuthenticatedIdentity): Promise<CurrentUser> {
    return toCurrentUser(await this.store.upsertUser(identity));
  }

  async getPublic(provider: string): Promise<PublicProvider> {
    if (!isValidUsername(provider)) {
      throw new AppError(
        "INPUT_INVALID",
        "Provider username must be 8-16 character lowercase kebab-case.",
        400,
      );
    }
    const user = await this.store.findUserByUsername(provider);
    if (!user || user.status !== "active") {
      throw new AppError("RESOURCE_NOT_FOUND", "Provider not found.", 404);
    }
    return toPublicProvider(user);
  }

  async createWalletLinkChallenge(
    identity: AuthenticatedIdentity,
    provider: string,
  ) {
    const actor = await this.requireSelf(identity, provider);
    const domain = this.options.challengeDomain ?? "http://localhost:3000";
    if (
      this.options.environment !== "local" &&
      new URL(domain).protocol !== "https:"
    ) {
      throw new Error("Cloud wallet challenge domain must use HTTPS");
    }
    const challenge = newWalletLinkChallenge({
      userId: actor.id,
      provider: actor.username,
      domain: new URL(domain).origin,
      now: this.options.now?.() ?? new Date(),
    });
    await this.store.createWalletLinkChallenge(challenge);
    return {
      challengeId: challenge.id,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString(),
    };
  }

  async confirmWalletLink(
    identity: AuthenticatedIdentity,
    provider: string,
    challengeId: string,
    address: string,
    signature: `0x${string}`,
    requestId: string,
  ) {
    const actor = await this.requireSelf(identity, provider);
    const challenge = await this.store.getWalletLinkChallenge(challengeId);
    if (
      !challenge ||
      challenge.userId !== actor.id ||
      !challenge.message.includes(`Provider: ${actor.username}\n`)
    ) {
      throw new AppError(
        "WALLET_CHALLENGE_INVALID",
        "Invalid wallet challenge.",
        403,
      );
    }
    if (challenge.consumedAt) {
      throw new AppError(
        "WALLET_CHALLENGE_USED",
        "Wallet challenge already used.",
        409,
      );
    }
    const now = this.options.now?.() ?? new Date();
    if (challenge.expiresAt.getTime() <= now.getTime()) {
      throw new AppError(
        "WALLET_CHALLENGE_EXPIRED",
        "Wallet challenge expired.",
        410,
      );
    }
    const walletAddress = await verifyWalletLinkSignature({
      message: challenge.message,
      address,
      signature,
    });
    const updated = await this.store.consumeWalletLinkChallenge({
      challengeId,
      userId: actor.id,
      walletAddress,
      now,
      requestId,
    });
    if (!updated) {
      throw new AppError(
        "WALLET_CHALLENGE_USED",
        "Wallet challenge already used.",
        409,
      );
    }
    return {
      walletAddress: updated.walletAddress,
      verifiedAt: updated.walletVerifiedAt?.toISOString(),
    };
  }
}
