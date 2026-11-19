import type { AuthenticatedIdentity } from "../auth/types.js";
import type { UserStatus } from "../identifiers.js";

export type ClerkWebhookUserEvent =
  | {
      type: "user.created" | "user.updated";
      data: { id: string; username: string };
    }
  | {
      type: "user.deleted";
      data: { id: string; deleted?: boolean };
    };

export interface UserRecord {
  id: string;
  clerkId: string;
  username: string;
  walletAddress: string | null;
  walletVerifiedAt: Date | null;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CurrentUser {
  clerkId: string;
  username: string;
  walletAddress: string | null;
  walletVerifiedAt: string | null;
  status: UserStatus;
}

export interface PublicProvider {
  provider: string;
  walletAddress: string | null;
  walletVerifiedAt: string | null;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WalletLinkChallenge {
  id: string;
  userId: string;
  message: string;
  nonceHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface ProviderStore {
  findUserByClerkId(clerkId: string): Promise<UserRecord | undefined>;
  findUserByUsername(username: string): Promise<UserRecord | undefined>;
  upsertUser(identity: AuthenticatedIdentity): Promise<UserRecord>;
  applyClerkWebhook(
    event: ClerkWebhookUserEvent,
    requestId?: string,
  ): Promise<void>;
  createWalletLinkChallenge(
    input: Omit<WalletLinkChallenge, "consumedAt">,
  ): Promise<void>;
  getWalletLinkChallenge(
    challengeId: string,
  ): Promise<WalletLinkChallenge | undefined>;
  consumeWalletLinkChallenge(input: {
    challengeId: string;
    userId: string;
    walletAddress: string;
    now: Date;
    requestId: string;
  }): Promise<UserRecord | undefined>;
}
