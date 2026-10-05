import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { InMemoryObjectStorage } from '../../integration/helpers/in-memory-storage';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('InMemoryObjectStorage', () => {
  it('round-trips bytes and the mime type', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.put('a/b', Readable.from([Buffer.from('hel'), Buffer.from('lo')]), 'text/plain');
    expect((await readAll(await storage.get('a/b'))).toString()).toBe('hello');
    expect(storage.objects.get('a/b')?.mimeType).toBe('text/plain');
  });

  it('stores nothing when the source stream errors midway', async () => {
    const storage = new InMemoryObjectStorage();
    async function* broken() {
      yield Buffer.from('partial');
      throw new Error('boom');
    }
    await expect(storage.put('k', Readable.from(broken()), 'text/plain')).rejects.toThrow('boom');
    expect(storage.objects.size).toBe(0);
  });

  it('rejects get for a missing key and tolerates deleting one', async () => {
    const storage = new InMemoryObjectStorage();
    await expect(storage.get('nope')).rejects.toThrow(/No such object/);
    await expect(storage.delete('nope')).resolves.toBeUndefined();
  });

  it('seed() places an object directly and delete() removes it', async () => {
    const storage = new InMemoryObjectStorage();
    storage.seed('k', Buffer.from('x'), 'text/plain');
    expect(storage.objects.size).toBe(1);
    await storage.delete('k');
    expect(storage.objects.size).toBe(0);
  });
});
