import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Env } from '../../config/env';
import type { ObjectStorage } from './object-storage';

export type S3StorageConfig = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 404) {
        throw error;
      }
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(key: string, body: Readable, mimeType: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: mimeType },
    });
    await upload.done();
  }

  async get(key: string): Promise<Readable> {
    const output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return output.Body as Readable;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export function createS3StorageFromEnv(env: Env): S3ObjectStorage {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new Error('S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set to enable document storage');
  }
  return new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}
