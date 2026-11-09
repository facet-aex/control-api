import type { AuthenticatedIdentity } from "../auth/types.js";

export const PROVIDER_ROLES = [
  "owner",
  "admin",
  "developer",
  "viewer",
] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

export interface UserRecord {
  id: string;
  externalSubject: string;
  email: string | null;
  displayName: string | null;
  status: "active" | "disabled";
}

export interface CurrentUser {
  id: string;
  email: string | null;
  displayName: string | null;
}

export interface ProviderMembershipRecord {
  user: CurrentUser;
  role: ProviderRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  websiteUrl: string | null;
  contact: string | null;
  walletAddress: string | null;
  status: "active" | "disabled";
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProviderInput {
  slug: string;
  name: string;
  description: string;
  websiteUrl?: string | undefined;
  contact?: string | undefined;
  walletAddress?: string | undefined;
}

export interface UpdateProviderInput {
  version: number;
  name?: string | undefined;
  description?: string | undefined;
  websiteUrl?: string | null | undefined;
  contact?: string | null | undefined;
  walletAddress?: string | null | undefined;
}

export interface ProviderStore {
  upsertUser(identity: AuthenticatedIdentity): Promise<UserRecord>;
  createProvider(input: {
    actorUserId: string;
    provider: CreateProviderInput;
    requestId: string;
  }): Promise<ProviderRecord>;
  getProvider(providerId: string): Promise<ProviderRecord | undefined>;
  getMembershipRole(
    providerId: string,
    userId: string,
  ): Promise<ProviderRole | undefined>;
  listMemberships(providerId: string): Promise<ProviderMembershipRecord[]>;
  setMembership(input: {
    actorUserId: string;
    providerId: string;
    targetUserId: string;
    role: ProviderRole;
    requestId: string;
  }): Promise<ProviderMembershipRecord>;
  removeMembership(input: {
    actorUserId: string;
    providerId: string;
    targetUserId: string;
    requestId: string;
  }): Promise<void>;
  listProvidersForUser(
    userId: string,
  ): Promise<Array<{ provider: ProviderRecord; role: ProviderRole }>>;
  updateProvider(input: {
    actorUserId: string;
    providerId: string;
    expectedVersion: number;
    patch: Omit<UpdateProviderInput, "version">;
    requestId: string;
  }): Promise<ProviderRecord | undefined>;
}

export interface PublicProvider {
  id: string;
  slug: string;
  name: string;
  description: string;
  websiteUrl: string | null;
  contact: string | null;
  walletAddress: string | null;
  status: "active" | "disabled";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderMembership {
  user: CurrentUser;
  role: ProviderRole;
  createdAt: string;
  updatedAt: string;
}
