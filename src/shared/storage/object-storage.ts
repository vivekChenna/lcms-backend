import type { Readable } from 'node:stream';

export interface ObjectStorage {
  put(key: string, body: Readable, mimeType: string): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}
