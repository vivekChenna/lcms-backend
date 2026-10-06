import type { Readable } from 'node:stream';
import { ServiceUnavailableError } from '../errors';
import type { ObjectStorage } from './object-storage';

// Stands in for real storage when S3 is not configured or unreachable at
// startup, so the rest of the API still runs; only document file operations
// fail, with a clear 503.
export class UnavailableObjectStorage implements ObjectStorage {
  private fail(): never {
    throw new ServiceUnavailableError('Document storage is not available');
  }

  async put(_key: string, _body: Readable, _mimeType: string): Promise<void> {
    this.fail();
  }

  async get(_key: string): Promise<Readable> {
    return this.fail();
  }

  async delete(_key: string): Promise<void> {
    this.fail();
  }
}
