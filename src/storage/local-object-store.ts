import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { AppError } from "../errors.js";
import type { ImmutableObject, ObjectStore } from "./object-store.js";

const objectKeyPattern = /^sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/u;

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export class LocalObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async putImmutable(content: Uint8Array): Promise<ImmutableObject> {
    const hash = sha256(content);
    const prefix = hash.slice(0, 2);
    const objectKey = `sha256/${prefix}/${hash}`;
    const directory = join(this.root, "sha256", prefix);
    const target = join(directory, hash);
    const temporary = join(directory, `.${hash}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }

    const stored = await readFile(target);
    if (sha256(stored) !== hash) {
      throw new AppError(
        "OBJECT_INTEGRITY_FAILED",
        "The immutable object failed its integrity check.",
        500,
      );
    }
    return { objectKey, sha256: hash, byteLength: content.byteLength };
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const match = objectKeyPattern.exec(objectKey);
    if (!match?.[1] || !match[2] || !match[2].startsWith(match[1])) {
      throw new AppError(
        "OBJECT_KEY_INVALID",
        "The object key is invalid.",
        400,
      );
    }
    const content = await readFile(
      join(this.root, "sha256", match[1], match[2]),
    );
    if (sha256(content) !== match[2]) {
      throw new AppError(
        "OBJECT_INTEGRITY_FAILED",
        "The immutable object failed its integrity check.",
        500,
      );
    }
    return content;
  }

  async delete(objectKey: string): Promise<void> {
    const match = objectKeyPattern.exec(objectKey);
    if (!match?.[1] || !match[2] || !match[2].startsWith(match[1])) {
      throw new AppError(
        "OBJECT_KEY_INVALID",
        "The object key is invalid.",
        400,
      );
    }
    await unlink(join(this.root, "sha256", match[1], match[2])).catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      },
    );
  }
}
