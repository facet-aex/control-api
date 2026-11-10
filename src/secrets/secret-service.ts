import type { AuthenticatedIdentity } from "../auth/types.js";
import { AppError } from "../errors.js";
import { requireProviderPermission } from "../providers/provider-rbac.js";
import type { ProviderStore } from "../providers/provider-types.js";
import type {
  SecretKind,
  SecretRecord,
  SecretStore,
  SecretValueStore,
} from "./secret-types.js";

function toSecretMetadata(record: SecretRecord) {
  return {
    id: record.id,
    providerId: record.providerId,
    kind:
      record.kind === "api_key"
        ? ("API_KEY" as const)
        : ("BEARER_TOKEN" as const),
    label: record.label,
    status:
      record.status === "active" ? ("ACTIVE" as const) : ("REVOKED" as const),
    usageCount: record.usageCount,
    createdAt: record.createdAt.toISOString(),
    rotatedAt: record.rotatedAt?.toISOString() ?? null,
  };
}

export class SecretService {
  constructor(
    private readonly providers: ProviderStore,
    private readonly secrets: SecretStore,
    private readonly values: SecretValueStore,
  ) {}

  private async authorize(identity: AuthenticatedIdentity, providerId: string) {
    const actor = await this.providers.upsertUser(identity);
    const role = await this.providers.getMembershipRole(providerId, actor.id);
    requireProviderPermission(role, "facet:write");
    return actor;
  }

  async create(
    identity: AuthenticatedIdentity,
    input: {
      providerId: string;
      kind: "API_KEY" | "BEARER_TOKEN";
      label: string;
      value: string;
    },
    requestId: string,
  ) {
    const actor = await this.authorize(identity, input.providerId);
    const stored = await this.values.put(input.value);
    try {
      const record = await this.secrets.createSecret({
        actorUserId: actor.id,
        providerId: input.providerId,
        kind: (input.kind === "API_KEY"
          ? "api_key"
          : "bearer_token") satisfies SecretKind,
        label: input.label,
        vaultProvider: stored.provider,
        vaultReference: stored.reference,
        requestId,
      });
      return { secret: toSecretMetadata(record) };
    } catch (error) {
      await this.values.delete(stored.reference).catch(() => undefined);
      throw error;
    }
  }

  async rotate(
    identity: AuthenticatedIdentity,
    input: { providerId: string; secretId: string; value: string },
    requestId: string,
  ) {
    const actor = await this.authorize(identity, input.providerId);
    const stored = await this.values.put(input.value);
    let rotated: Awaited<ReturnType<SecretStore["rotateSecret"]>>;
    try {
      rotated = await this.secrets.rotateSecret({
        actorUserId: actor.id,
        providerId: input.providerId,
        secretId: input.secretId,
        vaultProvider: stored.provider,
        vaultReference: stored.reference,
        requestId,
      });
      if (!rotated) {
        throw new AppError("RESOURCE_NOT_FOUND", "Secret not found.", 404);
      }
    } catch (error) {
      await this.values.delete(stored.reference).catch(() => undefined);
      throw error;
    }
    await this.values.delete(rotated.previousReference).catch(() => undefined);
    return { secret: toSecretMetadata(rotated.record) };
  }

  async revoke(
    identity: AuthenticatedIdentity,
    input: { providerId: string; secretId: string },
    requestId: string,
  ): Promise<void> {
    const actor = await this.authorize(identity, input.providerId);
    const revoked = await this.secrets.revokeSecret({
      actorUserId: actor.id,
      providerId: input.providerId,
      secretId: input.secretId,
      requestId,
    });
    if (!revoked) {
      throw new AppError("RESOURCE_NOT_FOUND", "Secret not found.", 404);
    }
    await this.values.delete(revoked.revokedReference).catch(() => undefined);
  }
}
