import { Readable } from 'node:stream';
import type { ObjectStorage } from '../../../src/shared/storage/object-storage';

export class InMemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { body: Buffer; mimeType: string }>();

  async put(key: string, body: Readable, mimeType: string): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk));
    }
    this.objects.set(key, { body: Buffer.concat(chunks), mimeType });
  }

  async get(key: string): Promise<Readable> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`No such object: ${key}`);
    }
    return Readable.from([object.body]);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  seed(key: string, body: Buffer, mimeType: string): void {
    this.objects.set(key, { body, mimeType });
  }
}
