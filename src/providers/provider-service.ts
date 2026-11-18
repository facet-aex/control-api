import { AppError } from "../errors.js";
import type { AuthenticatedIdentity } from "../auth/types.js";
import { requireProviderPermission } from "./provider-rbac.js";
import {
  newWalletLinkChallenge,
  verifyWalletLinkSignature,
} from "./wallet-link.js";
import type {
  CreateProviderInput,
  CurrentUser,
  ProviderMembership,
  ProviderRecord,
  ProviderRole,
  ProviderStore,
  PublicProvider,
  UpdateProviderInput,
} from "./provider-types.js";

function toCurrentUser(user: {
  id: string;
  username?: string | null;
  email: string | null;
  displayName: string | null;
}): CurrentUser {
  return {
    id: user.id,
    username: user.username ?? null,
    email: user.email,
    displayName: user.displayName,
  };
}

function toProviderMembership(membership: {
  user: CurrentUser;
  role: ProviderRole;
  createdAt: Date;
  updatedAt: Date;
}): ProviderMembership {
  return {
    user: membership.user,
    role: membership.role,
    createdAt: membership.createdAt.toISOString(),
    updatedAt: membership.updatedAt.toISOString(),
  };
}

function toPublicProvider(provider: ProviderRecord): PublicProvider {
  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    description: provider.description,
    websiteUrl: provider.websiteUrl,
    contact: provider.contact,
    walletAddress: provider.walletAddress,
    walletVerifiedAt: provider.walletVerifiedAt?.toISOString() ?? null,
    status: provider.status,
    version: provider.version,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
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

  private requireWalletProofForCloud(walletAddress: unknown): void {
    if (this.options.environment !== "local" && walletAddress !== undefined) {
      throw new AppError(
        "WALLET_PROOF_REQUIRED",
        "Link a payout wallet with a signed challenge.",
        403,
      );
    }
  }

  private async requireOwner(
    identity: AuthenticatedIdentity,
    providerId: string,
  ) {
    const actor = await this.store.upsertUser(identity);
    const provider = await this.store.getProvider(providerId);
    if (!provider || provider.status !== "active") {
      throw new AppError("RESOURCE_NOT_FOUND", "Provider not found.", 404);
    }
    const role = await this.store.getMembershipRole(providerId, actor.id);
    if (role !== "owner") {
      throw new AppError(
        "AUTHORIZATION_DENIED",
        "Only a provider owner may link its payout wallet.",
        403,
      );
    }
    return actor;
  }

  async createWalletLinkChallenge(
    identity: AuthenticatedIdentity,
    providerId: string,
  ) {
    const actor = await this.requireOwner(identity, providerId);
    const domain = this.options.challengeDomain ?? "http://localhost:3000";
    if (
      this.options.environment !== "local" &&
      new URL(domain).protocol !== "https:"
    ) {
      throw new Error("Cloud wallet challenge domain must use HTTPS");
    }
    const challenge = newWalletLinkChallenge({
      providerId,
      userId: actor.id,
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
    providerId: string,
    challengeId: string,
    address: string,
    signature: `0x${string}`,
    requestId: string,
  ) {
    const actor = await this.requireOwner(identity, providerId);
    const challenge = await this.store.getWalletLinkChallenge(challengeId);
    if (
      !challenge ||
      challenge.providerId !== providerId ||
      challenge.userId !== actor.id
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
    const provider = await this.store.consumeWalletLinkChallenge({
      challengeId,
      providerId,
      userId: actor.id,
      walletAddress,
      now,
      requestId,
    });
    if (!provider) {
      throw new AppError(
        "WALLET_CHALLENGE_USED",
        "Wallet challenge already used.",
        409,
      );
    }
    return {
      walletAddress: provider.walletAddress,
      verifiedAt: provider.walletVerifiedAt?.toISOString(),
    };
  }

  async getCurrentUser(identity: AuthenticatedIdentity): Promise<CurrentUser> {
    return toCurrentUser(await this.store.upsertUser(identity));
  }

  async create(
    identity: AuthenticatedIdentity,
    input: CreateProviderInput,
    requestId: string,
  ): Promise<PublicProvider> {
    this.requireWalletProofForCloud(input.walletAddress);
    const actor = await this.store.upsertUser(identity);
    const provider = await this.store.createProvider({
      actorUserId: actor.id,
      provider: input,
      requestId,
    });
    return toPublicProvider(provider);
  }

  async getPublic(providerId: string): Promise<PublicProvider> {
    const provider = await this.store.getProvider(providerId);
    if (!provider || provider.status !== "active") {
      throw new AppError("RESOURCE_NOT_FOUND", "Provider not found.", 404);
    }
    return toPublicProvider(provider);
  }

  async listMine(identity: AuthenticatedIdentity) {
    const actor = await this.store.upsertUser(identity);
    const memberships = await this.store.listProvidersForUser(actor.id);
    return memberships.map(({ provider, role }) => ({
      provider: toPublicProvider(provider),
      role,
    }));
  }

  async listMembers(
    identity: AuthenticatedIdentity,
    providerId: string,
  ): Promise<ProviderMembership[]> {
    const actor = await this.store.upsertUser(identity);
    const role = await this.store.getMembershipRole(providerId, actor.id);
    requireProviderPermission(role, "provider:read-private");
    return (await this.store.listMemberships(providerId)).map(
      toProviderMembership,
    );
  }

  async setMember(
    identity: AuthenticatedIdentity,
    providerId: string,
    targetUserId: string,
    role: ProviderRole,
    requestId: string,
  ): Promise<ProviderMembership> {
    const actor = await this.store.upsertUser(identity);
    return toProviderMembership(
      await this.store.setMembership({
        actorUserId: actor.id,
        providerId,
        targetUserId,
        role,
        requestId,
      }),
    );
  }

  async removeMember(
    identity: AuthenticatedIdentity,
    providerId: string,
    targetUserId: string,
    requestId: string,
  ): Promise<void> {
    const actor = await this.store.upsertUser(identity);
    await this.store.removeMembership({
      actorUserId: actor.id,
      providerId,
      targetUserId,
      requestId,
    });
  }

  async update(
    identity: AuthenticatedIdentity,
    providerId: string,
    input: UpdateProviderInput,
    requestId: string,
  ): Promise<PublicProvider> {
    this.requireWalletProofForCloud(input.walletAddress);
    const actor = await this.store.upsertUser(identity);
    const role = await this.store.getMembershipRole(providerId, actor.id);
    requireProviderPermission(role, "provider:update");

    const current = await this.store.getProvider(providerId);
    if (!current)
      throw new AppError("RESOURCE_NOT_FOUND", "Provider not found.", 404);
    if (current.version !== input.version) {
      throw new AppError(
        "VERSION_PRECONDITION_FAILED",
        "The provider has changed since it was loaded.",
        412,
        { currentVersion: current.version },
      );
    }

    const patch = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.websiteUrl !== undefined
        ? { websiteUrl: input.websiteUrl }
        : {}),
      ...(input.contact !== undefined ? { contact: input.contact } : {}),
      ...(input.walletAddress !== undefined
        ? { walletAddress: input.walletAddress }
        : {}),
    };
    const updated = await this.store.updateProvider({
      actorUserId: actor.id,
      providerId,
      expectedVersion: input.version,
      patch,
      requestId,
    });
    if (!updated) {
      throw new AppError(
        "VERSION_PRECONDITION_FAILED",
        "The provider changed during the update.",
        412,
      );
    }
    return toPublicProvider(updated);
  }
}
