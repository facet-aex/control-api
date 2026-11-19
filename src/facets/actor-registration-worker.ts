export interface ActorRegistrationJob {
  facetId: string;
  versionId: string;
  imageDigest: string;
  priceAtomic: string;
  payTo: string;
  schemaURI: string;
  signedRaw: string | null;
  txHash: string | null;
}

export interface OnChainActorRegistration {
  facetType: number;
  imageDigest: string;
  pricingModel: number;
  priceAtomic: string;
  payTo: string;
  schemaURI: string;
  active: boolean;
}

export interface ActorRegistrationWorkerStore {
  next(): Promise<ActorRegistrationJob | null>;
  saveSigned(
    versionId: string,
    signed: { hash: string; raw: string },
  ): Promise<void>;
  promote(job: ActorRegistrationJob): Promise<void>;
  fail(job: ActorRegistrationJob, errorCode: string): Promise<void>;
}

export interface ActorRegistrationChain {
  readRegistration(facetId: string): Promise<OnChainActorRegistration | null>;
  prepare(job: ActorRegistrationJob): Promise<{ hash: string; raw: string }>;
  broadcast(raw: string): Promise<void>;
  transactionStatus(
    hash: string,
  ): Promise<"confirmed" | "reverted" | "unknown">;
}

function matchesRegistration(
  job: ActorRegistrationJob,
  observed: OnChainActorRegistration,
): boolean {
  return (
    observed.facetType === 1 &&
    observed.imageDigest.toLowerCase() ===
      job.imageDigest.replace(/^sha256:/u, "0x").toLowerCase() &&
    observed.pricingModel === 0 &&
    observed.priceAtomic === job.priceAtomic &&
    observed.payTo.toLowerCase() === job.payTo.toLowerCase() &&
    observed.schemaURI === job.schemaURI &&
    observed.active
  );
}

export class ActorRegistrationWorker {
  constructor(
    private readonly store: ActorRegistrationWorkerStore,
    private readonly chain: ActorRegistrationChain,
  ) {}

  async runOnce(): Promise<"idle" | "pending" | "published" | "failed"> {
    const job = await this.store.next();
    if (!job) return "idle";

    try {
      const onChain = await this.chain.readRegistration(job.versionId);
      if (onChain && !matchesRegistration(job, onChain)) {
        await this.store.fail(job, "REGISTRY_MISMATCH");
        return "failed";
      }
      if (job.txHash && job.signedRaw) {
        const status = await this.chain.transactionStatus(job.txHash);
        if (status === "reverted") {
          await this.store.fail(job, "REGISTRY_TX_REVERTED");
          return "failed";
        }
        if (status === "confirmed" && onChain) {
          await this.store.promote(job);
          return "published";
        }
        if (status === "unknown" && !onChain) {
          try {
            await this.chain.broadcast(job.signedRaw);
          } catch {
            // The same signed bytes may already have reached a Fuji peer.
          }
        }
        return "pending";
      }
      if (onChain) {
        await this.store.fail(job, "REGISTRY_ALREADY_REGISTERED");
        return "failed";
      }
      const signed = await this.chain.prepare(job);
      await this.store.saveSigned(job.versionId, signed);
      try {
        await this.chain.broadcast(signed.raw);
      } catch {
        // Keep the signed transaction for reconciliation on the next pass.
      }
      return "pending";
    } catch {
      return "pending";
    }
  }
}
