import { createClerkClient, verifyToken } from "@clerk/backend";

import { AppError } from "../errors.js";
import { isValidUsername } from "../identifiers.js";
import {
  extractVerifiedClerkEvmWallet,
  type ClerkWeb3WalletLike,
} from "./clerk-wallet.js";
import type {
  AuthenticatedIdentity,
  AuthenticationInput,
  IdentityAuthenticator,
} from "./types.js";

export interface SyncedUserLookup {
  clerkId: string;
  username: string;
  walletAddress?: string | null;
  status: "active" | "disabled";
}

export type ClerkUserFetcher = (clerkId: string) => Promise<{
  username?: string | null;
  primaryWeb3WalletId?: string | null;
  web3Wallets?: readonly ClerkWeb3WalletLike[];
}>;

export interface ClerkAuthenticatorOptions {
  authorizedParties: string[];
  issuer?: string;
  jwtKey?: string;
  secretKey?: string;
  findUserByClerkId?: (
    clerkId: string,
  ) => Promise<SyncedUserLookup | undefined>;
  getUser?: ClerkUserFetcher;
}

export class ClerkAuthenticator implements IdentityAuthenticator {
  private readonly fetchUser: ClerkUserFetcher | null;

  constructor(private readonly options: ClerkAuthenticatorOptions) {
    if (options.getUser) {
      this.fetchUser = options.getUser;
    } else if (options.secretKey) {
      const clerkClient = createClerkClient({ secretKey: options.secretKey });
      this.fetchUser = (clerkId) => clerkClient.users.getUser(clerkId);
    } else {
      this.fetchUser = null;
    }
  }

  async authenticate(
    input: AuthenticationInput,
  ): Promise<AuthenticatedIdentity> {
    const match = /^Bearer\s+(.+)$/iu.exec(input.authorization ?? "");
    if (!match?.[1]) {
      throw new AppError(
        "AUTHENTICATION_REQUIRED",
        "A Clerk session Bearer token is required.",
        401,
      );
    }

    let subject: string;
    try {
      const payload = await verifyToken(match[1], {
        authorizedParties: this.options.authorizedParties,
        ...(this.options.issuer ? { issuer: this.options.issuer } : {}),
        ...(this.options.jwtKey ? { jwtKey: this.options.jwtKey } : {}),
        ...(this.options.secretKey
          ? { secretKey: this.options.secretKey }
          : {}),
      });

      if (!payload.sub) throw new Error("verified Clerk token has no subject");
      subject = payload.sub;
    } catch {
      throw new AppError(
        "AUTHENTICATION_REQUIRED",
        "The Clerk session token is invalid.",
        401,
      );
    }

    if (this.options.findUserByClerkId) {
      const synced = await this.options.findUserByClerkId(subject);
      if (synced) {
        if (synced.status === "disabled") {
          throw new AppError(
            "AUTHORIZATION_DENIED",
            "This FACET user is disabled.",
            403,
          );
        }
        if (!isValidUsername(synced.username)) {
          throw new AppError(
            "USERNAME_REQUIRED",
            "Set an 8-16 character lowercase kebab-case username in Clerk.",
            409,
          );
        }
        if (!synced.walletAddress && this.fetchUser) {
          try {
            const user = await this.fetchUser(subject);
            const walletAddress = extractVerifiedClerkEvmWallet({
              primaryId: user.primaryWeb3WalletId,
              wallets: user.web3Wallets,
            });
            if (walletAddress) {
              return { subject, username: synced.username, walletAddress };
            }
          } catch {
            // Preserve auth when user is already synced and Clerk REST is transiently unavailable.
          }
        }
        return { subject, username: synced.username };
      }
    }

    if (!this.fetchUser) {
      throw new AppError(
        "USERNAME_REQUIRED",
        "Set an 8-16 character lowercase kebab-case username in Clerk.",
        409,
      );
    }

    let user;
    try {
      user = await this.fetchUser(subject);
    } catch {
      throw new AppError(
        "CLERK_PROFILE_UNAVAILABLE",
        "Clerk user profile could not be loaded.",
        503,
      );
    }

    if (!user.username || !isValidUsername(user.username)) {
      throw new AppError(
        "USERNAME_REQUIRED",
        "Set an 8-16 character lowercase kebab-case username in Clerk.",
        409,
      );
    }

    const walletAddress = extractVerifiedClerkEvmWallet({
      primaryId: user.primaryWeb3WalletId,
      wallets: user.web3Wallets,
    });
    return {
      subject,
      username: user.username,
      ...(walletAddress ? { walletAddress } : {}),
    };
  }
}
