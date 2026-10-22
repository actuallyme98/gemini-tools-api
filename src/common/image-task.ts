import type { Entity } from '../agent/agent.types';

export type StoredImage = { base64: string; mimetype: string };
export type ImageTask = {
  operation:
    | 'background'
    | 'mockup'
    | 'mockup-batch'
    | 'ideas'
    | 'references'
    | 'analyze'
    | 'prompts';
  images: StoredImage[];
  provider?: string;
  imageModel?: string;
  prompt?: string;
  prompts?: string[];
  count?: number;
  variationIndex?: number;
};
export interface QueuedImageJob extends Entity {
  state:
    | 'preparing'
    | 'queued'
    | 'running'
    | 'done'
    | 'failed'
    | 'interrupted'
    | 'cancelled';
  requestId: string;
  inputHash: string;
  payload?: { storageKey: string; iv: string; tag: string };
  result?: unknown;
  error?: Record<string, unknown>;
  workerId?: string;
  leaseUntil?: number;
  queueReleased?: boolean;
}
export function storeImage(file: Express.Multer.File): StoredImage {
  return { base64: file.buffer.toString('base64'), mimetype: file.mimetype };
}
export function restoreImage(image: StoredImage): Express.Multer.File {
  return {
    buffer: Buffer.from(image.base64, 'base64'),
    mimetype: image.mimetype,
  } as Express.Multer.File;
}
