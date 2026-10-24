import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AgentStore } from './agent.store';
import { AgentAssetsService } from './agent-assets.service';
import { ApiError } from '../common/api-error';
import { AuditLogService } from '../audit/audit-log.service';
import type {
  AgentUser,
  Asset,
  ChatMessage,
  Conversation,
  Entity,
  MockupTemplate,
  Run,
  Step,
} from './agent.types';

export interface SharedMessage {
  id: string;
  role: ChatMessage['role'];
  text: string;
  createdAt: string;
  runId?: string;
  images: { id: string; role: 'source' | 'reference' | 'template' }[];
}
export interface SharedRun {
  id: string;
  summary: string;
  state: Run['state'];
  questions: string[];
  items: { title: string; prompt: string }[];
  resultIds: string[];
}
interface ShareContent extends Entity {
  messages: SharedMessage[];
  runs: SharedRun[];
  assets: Pick<Asset, 'id' | 'name' | 'width' | 'height' | 'kind'>[];
}
interface ConversationShare extends Entity {
  nonce: string;
  snapshotId: string;
  title: string;
  sharedAt: string;
  includeImages: boolean;
  messageCount: number;
  assetIds: string[];
  revoked: boolean;
}

const unavailable = () =>
  new ApiError(
    404,
    'CONVERSATION_SHARE_UNAVAILABLE',
    'Link chia sẻ không tồn tại hoặc đã được thu hồi.',
  );
const tooLarge = () =>
  new ApiError(
    400,
    'CONVERSATION_SHARE_TOO_LARGE',
    'Hội thoại quá lớn để chia sẻ. Hãy chia sẻ một hội thoại ngắn hơn.',
  );

@Injectable()
export class ConversationSharingService {
  constructor(
    private readonly store: AgentStore,
    private readonly assets: AgentAssetsService,
    private readonly config: ConfigService,
    @Optional() private readonly audit?: AuditLogService,
  ) {}

  private token(share: ConversationShare) {
    // A database copy alone must not grant access to decrypted shared images.
    const signature = createHmac(
      'sha256',
      Buffer.from(
        this.config.getOrThrow<string>('AGENT_ASSET_ENCRYPTION_KEY'),
        'hex',
      ),
    )
      .update(`conversation-share:${share.id}:${share.nonce}`)
      .digest('hex');
    return `${share.id}.${signature}`;
  }

  private status(share?: ConversationShare) {
    return share && !share.revoked
      ? {
          token: this.token(share),
          title: share.title,
          sharedAt: share.sharedAt,
          includeImages: share.includeImages,
          messageCount: share.messageCount,
        }
      : null;
  }

  async current(owner: string, conversationId: string) {
    await this.store.get<Conversation>('conversation', conversationId, owner);
    const share = await this.store.find<ConversationShare>(
      'conversation-share',
      conversationId,
    );
    return this.status(share?.owner === owner ? share : undefined);
  }

  async publish(owner: string, conversationId: string, includeImages: boolean) {
    const conversation = await this.store.get<Conversation>(
      'conversation',
      conversationId,
      owner,
    );
    const rate = createHash('sha256')
      .update(`share-publish:${owner}`)
      .digest('hex');
    if ((await this.store.loginAttempt(rate)) > 30)
      throw new ApiError(
        429,
        'CONVERSATION_SHARE_LIMIT',
        'Tạo/cập nhật link quá nhiều lần. Hãy thử lại sau 15 phút.',
      );
    const previous = await this.store.find<ConversationShare>(
      'conversation-share',
      conversationId,
    );
    if (previous && previous.owner !== owner) throw unavailable();
    const sharedAt = new Date().toISOString();
    const latest = await this.store.messageRecords(owner, conversationId, {
      limit: 1,
    });
    const messages: ChatMessage[] = [];
    let after: string | undefined;
    let textBytes = 0;
    while (latest.length) {
      const rows = await this.store.messageRecords(owner, conversationId, {
        after,
        until: latest[0].position,
        ascending: true,
        limit: 200,
      });
      for (const row of rows) {
        textBytes += Buffer.byteLength(row.message.text, 'utf8');
        if (messages.length >= 5000 || textBytes > 6 * 1024 * 1024)
          throw tooLarge();
        messages.push(row.message);
      }
      if (rows.length < 200) break;
      after = rows.at(-1).position;
    }
    if (!messages.length)
      throw new ApiError(
        400,
        'CONVERSATION_SHARE_EMPTY',
        'Hội thoại chưa có tin nhắn để chia sẻ.',
      );
    const messageRunIds = [
      ...new Set(
        messages.flatMap((message) => (message.runId ? [message.runId] : [])),
      ),
    ];
    if (messageRunIds.length > 250) throw tooLarge();
    const runs = await this.store.query<Run>(
      'run',
      { owner, conversationId, id: { $in: messageRunIds } },
      251,
    );
    if (runs.length > 250) throw tooLarge();
    const steps = includeImages
      ? await this.store.query<Step>(
          'step',
          { owner, runId: { $in: runs.map((run) => run.id) }, type: 'image' },
          5001,
        )
      : [];
    if (steps.length > 5000) throw tooLarge();
    const templateIds = includeImages
      ? [
          ...new Set(
            messages
              .flatMap((message) => message.attachments?.templateIds ?? [])
              .concat(runs.flatMap((run) => run.templateIds)),
          ),
        ]
      : [];
    if (templateIds.length > 1000) throw tooLarge();
    const templates = templateIds.length
      ? await this.store.query<MockupTemplate>(
          'template',
          { owner, id: { $in: templateIds } },
          1000,
        )
      : [];
    const templateAssets = new Map(
      templates.map((template) => [template.id, template.assetId]),
    );
    const publicMessages: SharedMessage[] = messages.map((message) => {
      const run = runs.find((run) => run.id === message.runId);
      const attachments =
        message.attachments ??
        (message.role === 'user' && run ? run : undefined);
      return {
        id: message.id,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        ...(run ? { runId: run.id } : {}),
        images:
          includeImages && attachments
            ? [
                ...attachments.sourceIds.map((id) => ({
                  id,
                  role: 'source' as const,
                })),
                ...attachments.targetIds.map((id) => ({
                  id,
                  role: 'reference' as const,
                })),
                ...attachments.templateIds.flatMap((id) =>
                  templateAssets.has(id)
                    ? [
                        {
                          id: templateAssets.get(id),
                          role: 'template' as const,
                        },
                      ]
                    : [],
                ),
              ]
            : [],
      };
    });
    const publicRuns: SharedRun[] = runs.map((run) => ({
      id: run.id,
      summary: run.summary,
      state: run.state,
      questions: [...run.questions],
      items: run.items.map(({ title, prompt }) => ({ title, prompt })),
      resultIds: [
        ...new Set(
          steps
            .filter((step) => step.runId === run.id && step.resultId)
            .map((step) => step.resultId),
        ),
      ],
    }));
    const assetIds = [
      ...new Set([
        ...publicMessages.flatMap((message) =>
          message.images.map((image) => image.id),
        ),
        ...publicRuns.flatMap((run) => run.resultIds),
      ]),
    ];
    if (assetIds.length > 1000) throw tooLarge();
    const assets = assetIds.length
      ? await this.store.query<Asset>(
          'asset',
          { owner, id: { $in: assetIds } },
          1000,
        )
      : [];
    const allowed = new Set(assets.map((asset) => asset.id));
    for (const message of publicMessages)
      message.images = message.images.filter((image) => allowed.has(image.id));
    for (const run of publicRuns)
      run.resultIds = run.resultIds.filter((id) => allowed.has(id));
    const content = this.store.create<ShareContent>(owner, {
      messages: publicMessages,
      runs: publicRuns,
      assets: assets.map(({ id, name, width, height, kind }) => ({
        id,
        name,
        width,
        height,
        kind,
      })),
    });
    if (Buffer.byteLength(JSON.stringify(content), 'utf8') > 8 * 1024 * 1024)
      throw tooLarge();
    await this.store.insert('conversation-share-content', content);
    const share = this.store.create<ConversationShare>(owner, {
      nonce:
        previous && !previous.revoked
          ? previous.nonce
          : randomBytes(32).toString('hex'),
      snapshotId: content.id,
      title: conversation.title,
      sharedAt,
      includeImages,
      messageCount: publicMessages.length,
      assetIds: [...allowed],
      revoked: false,
    });
    share.id = conversationId;
    try {
      if (previous) {
        const {
          id: _id,
          owner: _owner,
          createdAt: _createdAt,
          ...fields
        } = share;
        void _id;
        void _owner;
        void _createdAt;
        if (
          !(await this.store.patch<ConversationShare>(
            'conversation-share',
            conversationId,
            owner,
            fields,
            { updatedAt: previous.updatedAt },
          ))
        )
          throw new ApiError(
            409,
            'CONVERSATION_SHARE_CHANGED',
            'Link vừa thay đổi. Hãy tải lại trước khi tiếp tục.',
          );
      } else {
        await this.store.ensure('conversation-share', share);
        if (
          (
            await this.store.find<ConversationShare>(
              'conversation-share',
              conversationId,
            )
          )?.snapshotId !== content.id
        )
          throw new ApiError(
            409,
            'CONVERSATION_SHARE_CHANGED',
            'Link vừa được tạo ở tab khác. Hãy tải lại.',
          );
      }
    } catch (error) {
      await this.store
        .remove('conversation-share-content', content.id)
        .catch(() => undefined);
      throw error;
    }
    if (previous)
      await this.store
        .remove('conversation-share-content', previous.snapshotId)
        .catch(() => undefined);
    await this.audit?.write('conversation_share_published', {
      conversationId,
      includeImages,
      messageCount: share.messageCount,
    });
    return this.status(share);
  }

  async revoke(owner: string, conversationId: string) {
    await this.store.get<Conversation>('conversation', conversationId, owner);
    const share = await this.store.find<ConversationShare>(
      'conversation-share',
      conversationId,
    );
    if (!share || share.owner !== owner || share.revoked) return;
    if (
      !(await this.store.patch<ConversationShare>(
        'conversation-share',
        conversationId,
        owner,
        { revoked: true },
        { updatedAt: share.updatedAt },
      ))
    )
      throw new ApiError(
        409,
        'CONVERSATION_SHARE_CHANGED',
        'Link vừa thay đổi. Hãy tải lại trước khi thu hồi.',
      );
    await this.store
      .remove('conversation-share-content', share.snapshotId)
      .catch(() => undefined);
    await this.audit?.write('conversation_share_revoked', { conversationId });
  }

  private async authorize(token: string, ip: string) {
    const rate = createHash('sha256').update(`share-read:${ip}`).digest('hex');
    if ((await this.store.loginAttempt(rate)) > 1200)
      throw new ApiError(
        429,
        'CONVERSATION_SHARE_LIMIT',
        'Đang mở quá nhiều nội dung chia sẻ. Hãy thử lại sau 15 phút.',
      );
    if (!/^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(token)) throw unavailable();
    const share = await this.store.find<ConversationShare>(
      'conversation-share',
      token.slice(0, 36),
    );
    if (
      !share ||
      share.revoked ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(this.token(share)))
    )
      throw unavailable();
    const [owner, conversation] = await Promise.all([
      this.store.find<AgentUser>('user', share.owner),
      this.store.find<Conversation>('conversation', share.id),
    ]);
    if (!owner || owner.disabled || conversation?.owner !== share.owner)
      throw unavailable();
    return share;
  }

  async read(token: string, ip: string, after = 0, version?: string) {
    const share = await this.authorize(token, ip);
    if (version && version !== share.snapshotId)
      throw new ApiError(
        409,
        'CONVERSATION_SHARE_UPDATED',
        'Nội dung chia sẻ vừa được cập nhật. Hãy tải lại để xem bản mới.',
      );
    const content = await this.store.find<ShareContent>(
      'conversation-share-content',
      share.snapshotId,
    );
    if (!content || content.owner !== share.owner) throw unavailable();
    const messages = content.messages.slice(after, after + 40);
    const runIds = new Set(
      messages.flatMap((message) => (message.runId ? [message.runId] : [])),
    );
    const runs = content.runs.filter((run) => runIds.has(run.id));
    const assetIds = new Set([
      ...messages.flatMap((message) => message.images.map((image) => image.id)),
      ...runs.flatMap((run) => run.resultIds),
    ]);
    return {
      version: share.snapshotId,
      title: share.title,
      sharedAt: share.sharedAt,
      includeImages: share.includeImages,
      messages,
      runs,
      assets: content.assets.filter((asset) => assetIds.has(asset.id)),
      nextCursor: after + 40 < content.messages.length ? after + 40 : null,
    };
  }

  async preview(token: string, ip: string, assetId: string) {
    const share = await this.authorize(token, ip);
    if (!share.includeImages || !share.assetIds.includes(assetId))
      throw unavailable();
    // Previews strip metadata; the public link never grants access to originals.
    return this.assets.preview(share.owner, assetId);
  }
}
