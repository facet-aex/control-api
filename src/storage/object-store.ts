export interface ImmutableObject {
  objectKey: string;
  sha256: string;
  byteLength: number;
}

export interface ObjectStore {
  putImmutable(content: Uint8Array): Promise<ImmutableObject>;
  get(objectKey: string): Promise<Uint8Array>;
  delete(objectKey: string): Promise<void>;
}
