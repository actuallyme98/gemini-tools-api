import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Collection,
  GridFSBucket,
  MongoClient,
  ObjectId,
  type Document,
} from 'mongodb';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import { ApiError } from '../common/api-error';
import type { Conversation, Entity, Step } from './agent.types';

interface StoredRecord extends Document {
  kind: string;
  id: string;
  owner: string;
  data: Entity & { messages?: Document[] };
  updatedAt: Date;
  expiresAt?: Date;
}

@Injectable()
export class AgentStore implements OnModuleInit, OnApplicationShutdown {
  readonly enabled: boolean;
  readonly workerId = randomUUID();
  private client?: MongoClient;
  private records?: Collection<StoredRecord>;
  private images?: GridFSBucket;
  constructor(private readonly config: ConfigService) {
    this.enabled = config.get<boolean>('AGENT_ENABLED', false);
  }
  async onModuleInit() {
    if (!this.enabled) return;
    this.client = new MongoClient(
      this.config.getOrThrow<string>('MONGODB_URI'),
      {
        serverSelectionTimeoutMS: 10000,
        maxPoolSize: 15,
        writeConcern: { w: 'majority' },
        runtimeAdapters: { os },
      },
    );
    await this.client.connect();
    this.records = this.client
      .db(this.config.get<string>('MONGODB_DATABASE', 'lcgmedia'))
      .collection<StoredRecord>('agent_records');
    this.images = new GridFSBucket(
      this.client.db(this.config.get<string>('MONGODB_DATABASE', 'lcgmedia')),
      { bucketName: 'agent_image_backups' },
    );
    await this.records.createIndexes([
      { key: { kind: 1, id: 1 }, unique: true },
      { key: { kind: 1, owner: 1, updatedAt: -1 } },
      { key: { kind: 1, owner: 1, 'data.state': 1, updatedAt: 1 } },
      { key: { kind: 1, owner: 1, 'data.conversationId': 1, updatedAt: -1 } },
      { key: { kind: 1, owner: 1, 'data.runId': 1 } },
      { key: { kind: 1, 'data.runId': 1 } },
      { key: { kind: 1, 'data.state': 1, updatedAt: 1 } },
      {
        key: { 'data.email': 1 },
        unique: true,
        partialFilterExpression: { kind: 'user' },
      },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ]);
  }
  private database() {
    if (!this.records)
      throw new ApiError(
        503,
        'AGENT_DISABLED',
        'Agent chưa được bật trên máy chủ.',
      );
    return this.records;
  }
  create<T extends Entity>(owner: string, fields: Omit<T, keyof Entity>): T {
    const now = new Date().toISOString();
    return {
      ...fields,
      id: randomUUID(),
      owner,
      createdAt: now,
      updatedAt: now,
    } as T;
  }
  async insert<T extends Entity>(kind: string, value: T): Promise<T> {
    await this.database().insertOne({
      kind,
      id: value.id,
      owner: value.owner,
      data: value,
      updatedAt: new Date(),
      ...(kind === 'session'
        ? {
            expiresAt: new Date(
              (value as unknown as { expiresAt: number }).expiresAt,
            ),
          }
        : {}),
    });
    return value;
  }
  async ensure<T extends Entity>(kind: string, value: T) {
    try {
      await this.database().updateOne(
        { kind, id: value.id },
        {
          $setOnInsert: {
            kind,
            id: value.id,
            owner: value.owner,
            data: value,
            updatedAt: new Date(),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 11000))
        throw error;
    }
  }
  async patch<T extends Entity>(
    kind: string,
    id: string,
    owner: string,
    fields: Partial<T>,
    expected: Record<string, unknown> = {},
  ): Promise<T | undefined> {
    const previous =
      typeof expected.updatedAt === 'string'
        ? Date.parse(expected.updatedAt)
        : 0;
    const data = {
      ...fields,
      updatedAt: new Date(Math.max(Date.now(), previous + 1)).toISOString(),
    };
    const record = await this.database().findOneAndUpdate(
      {
        kind,
        id,
        owner,
        ...Object.fromEntries(
          Object.entries(expected).map(([key, value]) => [
            `data.${key}`,
            value,
          ]),
        ),
      },
      {
        $set: {
          ...Object.fromEntries(
            Object.entries(data).map(([key, value]) => [`data.${key}`, value]),
          ),
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    );
    return record?.data as T | undefined;
  }
  async find<T>(kind: string, id: string): Promise<T | undefined> {
    return (await this.database().findOne({ kind, id }))?.data as T | undefined;
  }
  async get<T extends Entity>(
    kind: string,
    id: string,
    owner: string,
  ): Promise<T> {
    const record = await this.find<T>(kind, id);
    if (!record || record.owner !== owner)
      throw new ApiError(
        404,
        'AGENT_NOT_FOUND',
        'Không tìm thấy dữ liệu trong tài khoản của bạn.',
      );
    return record;
  }
  async list<T>(kind: string, owner: string, limit = 200): Promise<T[]> {
    return (
      await this.database()
        .find({ kind, owner })
        .sort({ updatedAt: -1 })
        .limit(limit)
        .toArray()
    ).map((row) => row.data as T);
  }
  async query<T>(
    kind: string,
    fields: Record<string, unknown> = {},
    limit = 200,
    order: 1 | -1 = 1,
  ): Promise<T[]> {
    return (
      await this.database()
        .find({
          kind,
          ...Object.fromEntries(
            Object.entries(fields).map(([key, value]) => [
              key === 'owner' || key === 'id' ? key : `data.${key}`,
              value,
            ]),
          ),
        })
        .sort({ updatedAt: order })
        .limit(limit)
        .toArray()
    ).map((row) => row.data as T);
  }
  async remove(kind: string, id: string) {
    await this.database().deleteOne({ kind, id });
  }
  async claim(): Promise<Step | undefined> {
    const count = this.config.get<number>('AGENT_CONCURRENCY', 3);
    for (let index = 0; index < count; index++)
      await this.ensure('slot', {
        ...this.create<Entity>('', {}),
        id: `global:${index}`,
        leaseUntil: 0,
      });
    const slotToken = randomUUID();
    const slot = await this.database().findOneAndUpdate(
      {
        kind: 'slot',
        id: {
          $in: Array.from({ length: count }, (_, index) => `global:${index}`),
        },
        'data.leaseUntil': { $lt: Date.now() },
      },
      {
        $set: {
          'data.leaseUntil': Date.now() + 90000,
          'data.slotToken': slotToken,
        },
      },
      { returnDocument: 'after' },
    );
    if (!slot) return;
    const row = await this.database().findOneAndUpdate(
      { kind: 'step', 'data.state': 'queued' },
      {
        $set: {
          'data.state': 'running',
          'data.startedAt': new Date().toISOString(),
          'data.workerId': this.workerId,
          'data.leaseUntil': Date.now() + 90000,
          'data.slotId': slot.id,
          'data.slotToken': slotToken,
          updatedAt: new Date(),
        },
      },
      { sort: { updatedAt: 1 }, returnDocument: 'after' },
    );
    if (!row) await this.release({ slotId: slot.id, slotToken });
    return row?.data as Step | undefined;
  }
  async heartbeat(step: Step) {
    const updated = await this.patch<Step>(
      'step',
      step.id,
      step.owner,
      { leaseUntil: Date.now() + 90000 },
      {
        state: 'running',
        workerId: this.workerId,
        leaseUntil: { $gt: Date.now() },
      },
    );
    if (updated)
      await this.patch<Entity>(
        'slot',
        step.slotId,
        '',
        { leaseUntil: Date.now() + 90000 } as Partial<Entity>,
        { slotToken: step.slotToken, leaseUntil: { $gt: Date.now() } },
      );
    return updated;
  }
  async release(step: Pick<Step, 'slotId' | 'slotToken'>) {
    if (step.slotId)
      await this.patch<Entity>(
        'slot',
        step.slotId,
        '',
        { leaseUntil: 0 } as Partial<Entity>,
        { slotToken: step.slotToken },
      );
  }
  async appendMessage(
    conversationId: string,
    owner: string,
    message: Conversation['messages'][number],
  ) {
    await this.database().updateOne(
      {
        kind: 'conversation',
        id: conversationId,
        owner,
        'data.messages.id': { $ne: message.id },
      },
      [
        {
          $set: {
            'data.messages': {
              $slice: [
                {
                  $concatArrays: [
                    { $ifNull: ['$data.messages', []] },
                    { $literal: [message] },
                  ],
                },
                -200,
              ],
            },
            'data.updatedAt': new Date().toISOString(),
            updatedAt: new Date(),
          },
        },
      ],
    );
  }
  async loginAttempt(id: string) {
    const now = new Date();
    const record = await this.database().findOneAndUpdate(
      { kind: 'login-rate', id },
      [
        {
          $set: {
            kind: 'login-rate',
            id,
            owner: '',
            updatedAt: now,
            data: {
              id,
              owner: '',
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
              count: {
                $cond: [
                  { $gt: ['$expiresAt', now] },
                  { $add: [{ $ifNull: ['$data.count', 0] }, 1] },
                  1,
                ],
              },
            },
            expiresAt: {
              $cond: [
                { $gt: ['$expiresAt', now] },
                '$expiresAt',
                new Date(now.getTime() + 900000),
              ],
            },
          },
        },
      ],
      { upsert: true, returnDocument: 'after' },
    );
    return (record?.data as Entity & { count: number }).count;
  }
  async backupImage(id: string, encrypted: Buffer) {
    this.database();
    const stream = this.images.openUploadStream(`${id}.bin`);
    await new Promise<void>((resolve, reject) => {
      stream.once('finish', resolve);
      stream.once('error', reject);
      stream.end(encrypted);
    });
    return stream.id.toHexString();
  }
  async readImageBackup(id: string) {
    this.database();
    const stream = this.images.openDownloadStream(new ObjectId(id));
    return new Promise<Buffer>((resolve, reject) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024)
          stream.destroy(new Error('Invalid image backup size'));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  }
  async onApplicationShutdown() {
    await this.client?.close();
  }
}
