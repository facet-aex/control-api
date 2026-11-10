export type SecretKind = "api_key" | "bearer_token";

export interface SecretRecord {
  id: string;
  providerId: string;
  kind: SecretKind;
  label: string;
  vaultProvider: string;
  vaultReference: string;
  status: "active" | "revoked";
  usageCount: number;
  createdAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export interface SecretValueStore {
  put(value: string): Promise<{ provider: string; reference: string }>;
  get(reference: string): Promise<string>;
  delete(reference: string): Promise<void>;
}

export interface SecretStore {
  createSecret(input: {
    actorUserId: string;
    providerId: string;
    kind: SecretKind;
    label: string;
    vaultProvider: string;
    vaultReference: string;
    requestId: string;
  }): Promise<SecretRecord>;
  rotateSecret(input: {
    actorUserId: string;
    providerId: string;
    secretId: string;
    vaultProvider: string;
    vaultReference: string;
    requestId: string;
  }): Promise<{ record: SecretRecord; previousReference: string } | undefined>;
  revokeSecret(input: {
    actorUserId: string;
    providerId: string;
    secretId: string;
    requestId: string;
  }): Promise<{ record: SecretRecord; revokedReference: string } | undefined>;
}
