import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalSecretValueStore } from "../src/secrets/local-secret-value-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("LocalSecretValueStore", () => {
  it("stores values behind opaque references with restrictive file permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "facet-secrets-"));
    roots.push(root);
    const store = new LocalSecretValueStore(root);

    const stored = await store.put("secret-canary");

    expect(stored.provider).toBe("local-fs");
    expect(stored.reference).toMatch(/^secret\/[a-f0-9-]{36}$/u);
    expect(stored.reference).not.toContain(root);
    expect(await store.get(stored.reference)).toBe("secret-canary");
    const file = join(root, stored.reference.replace("secret/", ""));
    expect(await readFile(file, "utf8")).toBe("secret-canary");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    await store.delete(stored.reference);
    await expect(store.get(stored.reference)).rejects.toMatchObject({
      code: "SECRET_VALUE_NOT_FOUND",
    });
  });

  it("rejects forged references without reading outside its root", async () => {
    const root = await mkdtemp(join(tmpdir(), "facet-secrets-"));
    roots.push(root);
    const store = new LocalSecretValueStore(root);

    await expect(store.get("secret/../../etc/passwd")).rejects.toMatchObject({
      code: "SECRET_REFERENCE_INVALID",
    });
  });
});
