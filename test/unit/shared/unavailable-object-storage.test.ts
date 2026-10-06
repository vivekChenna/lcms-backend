import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { UnavailableObjectStorage } from '../../../src/shared/storage/unavailable-object-storage';
import { ServiceUnavailableError } from '../../../src/shared/errors';

describe('UnavailableObjectStorage', () => {
  const storage = new UnavailableObjectStorage();

  it('fails every operation with a 503 service-unavailable error', async () => {
    await expect(storage.put('k', Readable.from(['x']), 'text/plain')).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(storage.get('k')).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(storage.delete('k')).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(storage.get('k')).rejects.toMatchObject({ statusCode: 503 });
  });
});
