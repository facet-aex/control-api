import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalObjectStore } from "../src/storage/local-object-store.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("LocalObjectStore", () => {
  it("stores content immutably under a non-path public key", async () => {
    directory = await mkdtemp(join(tmpdir(), "facet-object-store-"));
    const store = new LocalObjectStore(directory);
    const content = Buffer.from("immutable OpenAPI source", "utf8");
    const expectedHash = createHash("sha256").update(content).digest("hex");

    const first = await store.putImmutable(content);
    const second = await store.putImmutable(content);

    expect(first).toEqual({
      objectKey: `sha256/${expectedHash.slice(0, 2)}/${expectedHash}`,
      sha256: expectedHash,
      byteLength: content.byteLength,
    });
    expect(second).toEqual(first);
    expect(Buffer.from(await store.get(first.objectKey))).toEqual(content);
  });

  it("rejects path traversal and detects stored-object corruption", async () => {
    directory = await mkdtemp(join(tmpdir(), "facet-object-store-"));
    const store = new LocalObjectStore(directory);
    await expect(store.get("../../.env")).rejects.toMatchObject({
      code: "OBJECT_KEY_INVALID",
    });

    const stored = await store.putImmutable(Buffer.from("original"));
    const [, prefix, hash] = stored.objectKey.split("/");
    await writeFile(join(directory, "sha256", prefix!, hash!), "corrupted");
    await expect(store.get(stored.objectKey)).rejects.toMatchObject({
      code: "OBJECT_INTEGRITY_FAILED",
    });
  });

  it("deletes only the exact validated object key", async () => {
    directory = await mkdtemp(join(tmpdir(), "facet-object-store-"));
    const store = new LocalObjectStore(directory);
    const stored = await store.putImmutable(Buffer.from("temporary"));

    await store.delete(stored.objectKey);
    await expect(store.get(stored.objectKey)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
