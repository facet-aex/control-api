import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { AppError } from "../errors.js";
import type { SecretValueStore } from "./secret-types.js";

const referencePattern = /^secret\/([a-f0-9-]{36})$/u;

export class LocalSecretValueStore implements SecretValueStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(reference: string): string {
    const match = referencePattern.exec(reference);
    if (!match?.[1]) {
      throw new AppError(
        "SECRET_REFERENCE_INVALID",
        "The secret reference is invalid.",
        400,
      );
    }
    return join(this.root, match[1]);
  }

  async put(value: string) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const reference = `secret/${id}`;
    await writeFile(this.path(reference), value, { flag: "wx", mode: 0o600 });
    return { provider: "local-fs", reference };
  }

  async get(reference: string): Promise<string> {
    try {
      return await readFile(this.path(reference), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AppError(
          "SECRET_VALUE_NOT_FOUND",
          "The secret value was not found.",
          404,
        );
      }
      throw error;
    }
  }

  async delete(reference: string): Promise<void> {
    await unlink(this.path(reference)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
