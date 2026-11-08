import { describe, expect, it } from "vitest";

import { hasProviderPermission } from "../src/providers/provider-rbac.js";

describe("provider role matrix", () => {
  it("permits only owners and admins to update provider profiles", () => {
    expect(hasProviderPermission("owner", "provider:update")).toBe(true);
    expect(hasProviderPermission("admin", "provider:update")).toBe(true);
    expect(hasProviderPermission("developer", "provider:update")).toBe(false);
    expect(hasProviderPermission("viewer", "provider:update")).toBe(false);
  });

  it("keeps Facet authoring separate from membership administration", () => {
    expect(hasProviderPermission("developer", "facet:write")).toBe(true);
    expect(hasProviderPermission("developer", "membership:manage")).toBe(false);
    expect(hasProviderPermission("viewer", "facet:write")).toBe(false);
  });
});
