import { AppError } from "../errors.js";
import type { ProviderRole } from "./provider-types.js";

export type ProviderPermission =
  | "provider:read-private"
  | "provider:update"
  | "facet:write"
  | "membership:manage";

const permissions: Record<ProviderRole, ReadonlySet<ProviderPermission>> = {
  owner: new Set([
    "provider:read-private",
    "provider:update",
    "facet:write",
    "membership:manage",
  ]),
  admin: new Set([
    "provider:read-private",
    "provider:update",
    "facet:write",
    "membership:manage",
  ]),
  developer: new Set(["provider:read-private", "facet:write"]),
  viewer: new Set(["provider:read-private"]),
};

export function hasProviderPermission(
  role: ProviderRole,
  permission: ProviderPermission,
): boolean {
  return permissions[role].has(permission);
}

export function requireProviderPermission(
  role: ProviderRole | undefined,
  permission: ProviderPermission,
): asserts role is ProviderRole {
  if (!role || !hasProviderPermission(role, permission)) {
    throw new AppError(
      "AUTHORIZATION_DENIED",
      "The authenticated user is not authorized for this provider.",
      403,
    );
  }
}
