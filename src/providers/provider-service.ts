import { AppError } from "../errors.js";
import type { AuthenticatedIdentity } from "../auth/types.js";
import { requireProviderPermission } from "./provider-rbac.js";
import type {
  CreateProviderInput,
  ProviderRecord,
  ProviderStore,
  PublicProvider,
  UpdateProviderInput,
} from "./provider-types.js";

function toPublicProvider(provider: ProviderRecord): PublicProvider {
  return {
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    description: provider.description,
    websiteUrl: provider.websiteUrl,
    contact: provider.contact,
    walletAddress: provider.walletAddress,
    status: provider.status,
    version: provider.version,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

export class ProviderService {
  constructor(private readonly store: ProviderStore) {}

  async create(
    identity: AuthenticatedIdentity,
    input: CreateProviderInput,
    requestId: string,
  ): Promise<PublicProvider> {
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

  async update(
    identity: AuthenticatedIdentity,
    providerId: string,
    input: UpdateProviderInput,
    requestId: string,
  ): Promise<PublicProvider> {
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
