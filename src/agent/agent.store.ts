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
import type {
  CompanySettings,
  Conversation,
  Entity,
  MessageRecord,
  Step,
  Run,
} from './agent.types';
import { decodeCursor, encodeCursor } from './agent-pagination';

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
    if (!this.enabled && !this.config.get<boolean>('QUEUE_ENABLED', true))
      return;
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
      { key: { kind: 1, updatedAt: -1, id: -1 } },
      { key: { kind: 1, owner: 1, updatedAt: -1 } },
      { key: { kind: 1, owner: 1, 'data.state': 1, updatedAt: 1 } },
      { key: { kind: 1, owner: 1, 'data.conversationId': 1, updatedAt: -1 } },
      {
        key: {
          kind: 1,
          owner: 1,
          'data.conversationId': 1,
          'data.position': -1,
        },
      },
      { key: { kind: 1, owner: 1, 'data.createdAt': -1, id: -1 } },
      { key: { kind: 1, owner: 1, 'data.runId': 1 } },
      { key: { kind: 1, 'data.runId': 1 } },
      { key: { kind: 1, 'data.state': 1, updatedAt: 1 } },
      {
        key: { 'data.email': 1 },
        unique: true,
        partialFilterExpression: { kind: 'user' },
      },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      {
        key: { 'data.googleSub': 1 },
        unique: true,
        partialFilterExpression: {
          kind: 'user',
          'data.googleSub': { $type: 'string' },
        },
      },
    ]);
    await this.migrateChatHistory();
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
      ...(['session', 'google-nonce'].includes(kind)
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
  async revokeUserSessions(owner: string) {
    return (await this.database().deleteMany({ kind: 'session', owner }))
      .deletedCount;
  }
  async firstAdministrator() {
    return (
      await this.database().findOne(
        { kind: 'user', 'data.role': 'admin', 'data.disabled': { $ne: true } },
        { sort: { 'data.createdAt': 1, id: 1 } },
      )
    )?.data;
  }
  async adminPage<T>(
    kind: string,
    fields: Record<string, unknown>,
    page: number,
    limit: number,
  ) {
    const filter = {
      kind,
      ...Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [
          key === 'owner' || key === 'id' ? key : `data.${key}`,
          value,
        ]),
      ),
    };
    const [rows, total] = await Promise.all([
      this.database()
        .find(filter)
        .sort({ updatedAt: -1, id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      this.database().countDocuments(filter, { maxTimeMS: 5000 }),
    ]);
    return { items: rows.map((row) => row.data as T), total, page, limit };
  }
  async adminUsage(owners: string[]) {
    return this.database()
      .aggregate<{ owner: string; kind: string; count: number; bytes: number }>(
        [
          {
            $match: {
              owner: { $in: owners },
              kind: { $in: ['run', 'asset', 'session'] },
              $or: [
                { kind: { $ne: 'session' } },
                { 'data.expiresAt': { $gt: Date.now() } },
              ],
            },
          },
          {
            $group: {
              _id: { owner: '$owner', kind: '$kind' },
              count: { $sum: 1 },
              bytes: { $sum: { $ifNull: ['$data.bytes', 0] } },
            },
          },
          {
            $project: {
              _id: 0,
              owner: '$_id.owner',
              kind: '$_id.kind',
              count: 1,
              bytes: 1,
            },
          },
        ],
        { maxTimeMS: 5000 },
      )
      .toArray();
  }
  async adminSnapshot() {
    const [result] = await this.database()
      .aggregate<{
        totals: { _id: string; count: number }[];
        runs: { _id: string; count: number }[];
        steps: { _id: string; count: number }[];
        storage: { count: number; bytes: number; backups: number }[];
        daily: { _id: string; count: number }[];
        sessions: { count: number }[];
      }>(
        [
          {
            $match: {
              kind: {
                $in: ['user', 'run', 'step', 'asset', 'template', 'session'],
              },
            },
          },
          {
            $facet: {
              totals: [{ $group: { _id: '$kind', count: { $sum: 1 } } }],
              runs: [
                { $match: { kind: 'run' } },
                { $group: { _id: '$data.state', count: { $sum: 1 } } },
              ],
              steps: [
                { $match: { kind: 'step' } },
                { $group: { _id: '$data.state', count: { $sum: 1 } } },
              ],
              storage: [
                { $match: { kind: 'asset' } },
                {
                  $group: {
                    _id: null,
                    count: { $sum: 1 },
                    bytes: { $sum: '$data.bytes' },
                    backups: {
                      $sum: {
                        $cond: [
                          {
                            $regexMatch: {
                              input: '$data.storageKey',
                              regex: '^mongo:',
                            },
                          },
                          1,
                          0,
                        ],
                      },
                    },
                  },
                },
              ],
              daily: [
                {
                  $match: {
                    kind: 'run',
                    'data.createdAt': {
                      $gte: new Date(Date.now() - 7 * 86400000).toISOString(),
                    },
                  },
                },
                {
                  $group: {
                    _id: { $substrBytes: ['$data.createdAt', 0, 10] },
                    count: { $sum: 1 },
                  },
                },
                { $sort: { _id: 1 } },
              ],
              sessions: [
                {
                  $match: {
                    kind: 'session',
                    'data.expiresAt': { $gt: Date.now() },
                  },
                },
                { $count: 'count' },
              ],
            },
          },
        ],
        { maxTimeMS: 5000 },
      )
      .toArray();
    return result;
  }
  async consumeGoogleNonce(id: string) {
    const result = await this.database().deleteOne({
      kind: 'google-nonce',
      id,
      'data.expiresAt': { $gt: Date.now() },
    });
    return result.deletedCount === 1;
  }
  async claim(id?: string, owner?: string): Promise<Step | undefined> {
    if (
      (await this.find<CompanySettings>('company-settings', 'company'))
        ?.queuePaused
    )
      return;
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
      { kind: 'step', 'data.state': 'queued', ...(id ? { id, owner } : {}) },
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
  async releaseAdmission(id: string, owner: string, phase: string) {
    await this.database().updateOne(
      { kind: 'run', id, owner, 'data.queueAdmission': phase },
      { $set: { 'data.queueAdmissionReleased': true } },
    );
  }
  async appendMessage(
    conversationId: string,
    owner: string,
    message: Conversation['messages'][number],
  ) {
    await this.get<Conversation>('conversation', conversationId, owner);
    if (message.role === 'user' && message.runId && !message.attachments) {
      const run = await this.find<Run>('run', message.runId);
      if (run?.owner === owner && run.conversationId === conversationId)
        message = {
          ...message,
          attachments: {
            sourceIds: run.sourceIds,
            targetIds: run.targetIds,
            templateIds: run.templateIds,
          },
        };
    }
    await this.ensure('message', {
      id: `${conversationId}:${message.id}`,
      owner,
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
      conversationId,
      position: `${message.createdAt}|${message.id}`,
      message,
    } satisfies MessageRecord);
    await this.database().updateOne(
      { kind: 'conversation', id: conversationId, owner },
      {
        $set: {
          'data.updatedAt': new Date().toISOString(),
          updatedAt: new Date(),
        },
      },
    );
  }
  private async migrateChatHistory() {
    const cursor = this.database().find({
      kind: 'conversation',
      'data.messages.0': { $exists: true },
    });
    for await (const record of cursor) {
      const conversation = record.data as Conversation;
      for (const message of conversation.messages)
        await this.appendMessage(conversation.id, conversation.owner, message);
      // Remove the embedded copy only after every original message is durably archived.
      await this.database().updateOne(
        {
          kind: 'conversation',
          id: conversation.id,
          'data.messages': conversation.messages,
        },
        { $set: { 'data.messages': [] } },
      );
    }
  }
  async messageRecords(
    owner: string,
    conversationId: string,
    options: {
      before?: string;
      after?: string;
      until?: string;
      limit?: number;
      ascending?: boolean;
    } = {},
  ) {
    const position = {
      ...(options.before ? { $lt: options.before } : {}),
      ...(options.after ? { $gt: options.after } : {}),
      ...(options.until ? { $lte: options.until } : {}),
    };
    return (
      await this.database()
        .find({
          kind: 'message',
          owner,
          'data.conversationId': conversationId,
          ...(Object.keys(position).length
            ? { 'data.position': position }
            : {}),
        })
        .sort({ 'data.position': options.ascending ? 1 : -1 })
        .limit(options.limit ?? 40)
        .toArray()
    ).map((record) => record.data as MessageRecord);
  }
  async messagePage(
    owner: string,
    conversationId: string,
    before?: string,
    limit = 40,
  ) {
    await this.get<Conversation>('conversation', conversationId, owner);
    const records = await this.messageRecords(owner, conversationId, {
      before: decodeCursor(before),
      limit: limit + 1,
    });
    const hasMore = records.length > limit;
    const page = records.slice(0, limit).reverse();
    return {
      items: page.map((record) => record.message),
      hasMore,
      nextCursor: hasMore ? encodeCursor(page[0].position) : null,
    };
  }
  async conversationPage(owner: string, before?: string, limit = 30) {
    const boundary = decodeCursor(before);
    const [date, id] = boundary?.split('|') ?? [];
    const records = await this.database()
      .find(
        {
          kind: 'conversation',
          owner,
          ...(boundary
            ? {
                $or: [
                  { 'data.createdAt': { $lt: date } },
                  { 'data.createdAt': date, id: { $lt: id } },
                ],
              }
            : {}),
        },
        { projection: { 'data.messages': 0 } },
      )
      .sort({ 'data.createdAt': -1, id: -1 })
      .limit(limit + 1)
      .toArray();
    const hasMore = records.length > limit;
    const items = records
      .slice(0, limit)
      .map((record) => record.data as Conversation);
    const last = items.at(-1);
    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last ? encodeCursor(`${last.createdAt}|${last.id}`) : null,
    };
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
  async readImageBackup(id: string, maxBytes = 32 * 1024 * 1024) {
    this.database();
    const stream = this.images.openDownloadStream(new ObjectId(id));
    return new Promise<Buffer>((resolve, reject) => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes)
          stream.destroy(new Error('Invalid image backup size'));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  }
  async deleteImageBackup(id: string) {
    await this.images?.delete(new ObjectId(id));
  }
  async onApplicationShutdown() {
    await this.client?.close();
  }
}
