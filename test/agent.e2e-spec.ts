import { TaskQueueService } from '../src/queue/task-queue.service';
import { TestTaskQueue } from './queue-fixture';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import sharp from 'sharp';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  AgentController,
  AgentAuthController,
} from '../src/agent/agent.controller';
import { AgentStore } from '../src/agent/agent.store';
import { AgentAuthService, AgentGuard } from '../src/agent/agent-auth.service';
import { AgentAssetsService } from '../src/agent/agent-assets.service';
import { AgentService } from '../src/agent/agent.service';
import { WorkflowsController } from '../src/agent/workflows.controller';
import { WorkflowsService } from '../src/agent/workflows.service';
import { AgentContext } from '../src/agent/agent-context';
import { AgentWorker } from '../src/agent/agent.worker';
import { AIService } from '../src/ai/ai.service';
import { R2Service } from '../src/r2/r2.service';
import { AuditLogService } from '../src/audit/audit-log.service';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import type {
  Asset,
  Conversation,
  Run,
  Step,
  CustomWorkflow,
  WorkflowExecution,
  ConversationMemory,
} from '../src/agent/agent.types';
import { MOCKUP_RULES } from '../src/agent/agent.prompts';
import { ApiError } from '../src/common/api-error';

describe('POD agent with real MongoDB (mocked AI and R2)', () => {
  let mongo: MongoMemoryServer,
    app: INestApplication,
    store: AgentStore,
    worker: AgentWorker;
  let token: string, otherToken: string, owner: string;
  let source: Asset, target: Asset, png: Buffer, targetPng: Buffer;
  const encrypted = new Map<string, Buffer>();
  const ai = {
    validateSelection: jest.fn(),
    validateImageModel: jest.fn(() => Promise.resolve(undefined)),
    agentJSON: jest.fn((prompt: string): Promise<unknown> => {
      if (prompt.startsWith('Tóm tắt'))
        return Promise.resolve({
          summary:
            'Giữ nguyên chữ POKEMON, màu sản phẩm, ID ảnh nguồn và bối cảnh đích.',
        });
      if (prompt.startsWith('Chọn công cụ'))
        return Promise.resolve({
          operation: prompt.includes('test-auto-choice')
            ? 'mockup_ai'
            : 'design',
          summary: 'Tạo ý tưởng thiết kế',
          questions:
            prompt.includes('test-auto-choice') && !prompt.includes('"answer"')
              ? [
                  {
                    question: 'Chọn cách xử lý sản phẩm?',
                    options: [
                      { label: 'Thay toàn bộ sản phẩm' },
                      { label: 'Chỉ chuyển hình in' },
                    ],
                  },
                ]
              : [],
        });
      if (prompt.startsWith('Phân tích'))
        return Promise.resolve({ images: [] });
      if (prompt.startsWith('Kiểm tra'))
        return Promise.resolve({ verdict: 'pass', notes: ['Đúng cảnh đích.'] });
      const data = JSON.parse(prompt.split('DỮ LIỆU:\n')[1]) as {
        tasks: unknown[];
        autoAnswers?: { question: string; answer: string }[];
      };
      return Promise.resolve({
        summary: 'Kế hoạch thử nghiệm',
        questions:
          (prompt.includes('test-auto-loop') ||
            (prompt.includes('test-clarification') &&
              !data.autoAnswers?.length)) &&
          !prompt.includes('Thông tin bổ sung mới nhất')
            ? [
                {
                  question: prompt.includes('test-auto-loop')
                    ? `Xác nhận bước ${(data.autoAnswers?.length ?? 0) + 1}?`
                    : 'Bạn muốn thay sản phẩm hay chỉ chuyển hình in?',
                  options: [
                    {
                      label: 'Thay toàn bộ sản phẩm',
                      description: 'Giữ bối cảnh ảnh tham chiếu.',
                    },
                    { label: 'Chỉ chuyển hình in' },
                  ],
                },
              ]
            : [],
        items: data.tasks.map((_, index) => ({
          title: `Ảnh ${index + 1}`,
          prompt: 'Thay sản phẩm trong ảnh đích bằng sản phẩm nguồn.',
        })),
      });
    }),
    replaceBackground: jest.fn(() =>
      Promise.resolve({
        buffer: png,
        mimeType: 'image/png',
      }),
    ),
    generateImage: jest.fn(() => Promise.resolve(png)),
    editImage: jest.fn(() => Promise.resolve(png)),
  };
  const audit = {
    run: (_context: unknown, fn: () => unknown) => fn(),
    write: jest.fn(() => Promise.resolve(undefined)),
    generatedImage: jest.fn(() => Promise.resolve(undefined)),
  };
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const get = (url: string, auth = token) =>
    request(http())
      .get(`/api/agent${url}`)
      .set('Authorization', `Bearer ${auth}`);
  const post = (url: string, body: unknown = {}, auth = token) =>
    request(http())
      .post(`/api/agent${url}`)
      .set('Authorization', `Bearer ${auth}`)
      .send(body as object);
  const wait = async (work: () => Promise<boolean>) => {
    for (let i = 0; i < 150; i++) {
      if (await work()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Agent did not finish');
  };

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    png = await sharp({
      create: { width: 32, height: 32, channels: 4, background: '#ff0000' },
    })
      .png()
      .toBuffer();
    const settings = {
      AGENT_ENABLED: true,
      AGENT_WORKER_ENABLED: false,
      MONGODB_URI: mongo.getUri(),
      MONGODB_DATABASE: 'agent_test',
      AGENT_ASSET_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      AGENT_CONCURRENCY: 3,
    };
    targetPng = await sharp({
      create: { width: 32, height: 32, channels: 4, background: '#0000ff' },
    })
      .png()
      .toBuffer();
    const module = await Test.createTestingModule({
      controllers: [AgentController, AgentAuthController, WorkflowsController],
      providers: [
        AgentStore,
        AgentAuthService,
        AgentGuard,
        AgentAssetsService,
        AgentService,
        { provide: TaskQueueService, useValue: new TestTaskQueue() },
        AgentWorker,
        WorkflowsService,
        { provide: ConfigService, useValue: new ConfigService(settings) },
        { provide: AIService, useValue: ai },
        {
          provide: R2Service,
          useValue: {
            putAgentObject: jest.fn(
              (_owner: string, id: string, buffer: Buffer) => {
                encrypted.set(id, buffer);
                return Promise.resolve(id);
              },
            ),
            getAgentObject: jest.fn((id: string) =>
              Promise.resolve(encrypted.get(id)),
            ),
          },
        },
        { provide: AuditLogService, useValue: audit },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    store = app.get(AgentStore);
    worker = app.get(AgentWorker);
    const auth = app.get(AgentAuthService);
    const user = await auth.createUser(
      'designer@example.com',
      'test-password-at-least-12',
      'designer',
    );
    owner = user.id;
    await auth.createUser(
      'other@example.com',
      'test-password-at-least-12',
      'designer',
    );
    token = (await auth.login(user.email, 'test-password-at-least-12', 'one'))
      .token;
    otherToken = (
      await auth.login('other@example.com', 'test-password-at-least-12', 'two')
    ).token;
    const upload = async (kind: string) =>
      (
        await request(http())
          .post('/api/agent/assets')
          .set('Authorization', `Bearer ${token}`)
          .field('kind', kind)
          .attach('image', kind === 'reference' ? targetPng : png, {
            filename: `${kind}.png`,
            contentType: 'image/png',
          })
          .expect(201)
      ).body as Asset;
    source = await upload('source');
    target = await upload('reference');
  }, 120000);
  afterAll(async () => {
    if (app) await app.close();
    if (mongo) await mongo.stop();
  });

  const newRun = async (overrides: Record<string, unknown> = {}) => {
    const conversation = (
      await post('/conversations', { title: 'Kiểm tra ornament' }).expect(201)
    ).body as Conversation;
    const run = (
      await post(`/conversations/${conversation.id}/messages`, {
        id: randomUUID(),
        text: 'Thay ornament trong ảnh tham chiếu bằng ornament nguồn',
        operation: 'mockup_ai',
        sourceIds: [source.id],
        targetIds: [target.id],
        validateVisually: true,
        ...overrides,
      }).expect(202)
    ).body as Run;
    await worker.tick();
    await wait(
      async () => (await store.find<Run>('run', run.id))?.state === 'draft',
    );
    return { conversation, run: await store.find<Run>('run', run.id) };
  };

  it('keeps structured questions and resumes planning after answers without generating images', async () => {
    const conversation = (
      await post('/conversations', { title: 'Clarification' }).expect(201)
    ).body as Conversation;
    const input = {
      id: randomUUID(),
      text: 'test-clarification: Thay sản phẩm trong ảnh tham chiếu.',
      operation: 'mockup_ai',
      sourceIds: [source.id],
      targetIds: [target.id],
    };
    await post(`/conversations/${conversation.id}/messages`, input).expect(202);
    await worker.tick();
    await wait(
      async () =>
        (await store.find<Step>('step', `${input.id}:plan`))?.state === 'done',
    );
    const waiting = (await get(`/conversations/${conversation.id}`).expect(200))
      .body as { runs: Run[] };
    expect(waiting.runs[0].state).toBe('needs_input');
    expect(waiting.runs[0].approvalMode).toBe('manual');
    expect(waiting.runs[0].autoAnswers).toBeUndefined();
    expect(waiting.runs[0].questions[0]).toContain('thay sản phẩm');
    expect(waiting.runs[0].clarifications[0].options[0].label).toBe(
      'Thay toàn bộ sản phẩm',
    );
    const paidCalls = ai.replaceBackground.mock.calls.length;
    await post(`/runs/${input.id}/start`, {
      updatedAt: waiting.runs[0].updatedAt,
    }).expect(409);
    const answer = {
      ...input,
      id: randomUUID(),
      text: `${input.text}\nThông tin bổ sung mới nhất: Thay toàn bộ sản phẩm.`,
    };
    await post(`/conversations/${conversation.id}/messages`, answer).expect(
      202,
    );
    await post(`/conversations/${conversation.id}/messages`, answer).expect(
      202,
    );
    await worker.tick();
    await wait(
      async () => (await store.find<Run>('run', answer.id))?.state === 'draft',
    );
    const detail = (await get(`/conversations/${conversation.id}`).expect(200))
      .body as { runs: Run[]; conversation: Conversation };
    expect(detail.runs).toHaveLength(2);
    expect(detail.runs[1].questions).toEqual([]);
    expect(detail.runs[1].sourceIds).toEqual([source.id]);
    expect(detail.runs[1].targetIds).toEqual([target.id]);
    expect(
      detail.conversation.messages.filter(
        (message) => message.runId === answer.id && message.role === 'user',
      ),
    ).toHaveLength(1);
    expect(ai.replaceBackground.mock.calls.length).toBe(paidCalls);
    await post(`/runs/${answer.id}/cancel`);
  });

  it('prioritizes missing attachments over model questions so required inputs stay actionable', async () => {
    const conversation = (
      await post('/conversations', { title: 'Missing inputs' }).expect(201)
    ).body as Conversation;
    const id = randomUUID();
    ai.agentJSON.mockResolvedValueOnce({
      operation: 'mockup_ai',
      summary: 'Cần ảnh để tạo mockup.',
      questions: Array.from(
        { length: 5 },
        (_, index) => `Câu hỏi ${index + 1}`,
      ),
    });
    await post(`/conversations/${conversation.id}/messages`, {
      id,
      text: 'Tạo mockup sản phẩm',
      operation: 'auto',
      approvalMode: 'auto',
    }).expect(202);
    await worker.tick();
    await wait(
      async () =>
        (await store.find<Step>('step', `${id}:plan`))?.state === 'done',
    );
    const run = await store.find<Run>('run', id);
    expect(run.state).toBe('needs_input');
    expect(
      run.clarifications.slice(0, 2).map((question) => question.input),
    ).toEqual(['source', 'reference']);
    expect(run.questions).toHaveLength(5);
    expect(run.autoAnswers).toBeUndefined();
    await post(`/runs/${id}/cancel`);
  });

  it.each(['mockup_ai', 'auto'])(
    'auto approval resolves recommendations for %s in the worker and retains final prompt approval',
    async (operation) => {
      const marker =
        operation === 'auto' ? 'test-auto-choice' : 'test-clarification';
      const paid = ai.replaceBackground.mock.calls.length;
      const { conversation, run } = await newRun({
        text: `${marker}: Thay toàn bộ sản phẩm nguồn vào ảnh tham chiếu.`,
        operation,
        approvalMode: 'auto',
      });
      expect(run.approvalMode).toBe('auto');
      expect(run.state).toBe('draft');
      expect(run.autoAnswers).toEqual([
        expect.objectContaining({ answer: 'Thay toàn bộ sản phẩm' }),
      ]);
      expect(run.autoApprovalRounds).toBe(1);
      expect(run.questions).toEqual([]);
      expect(run.brief).toContain(marker);
      expect(ai.replaceBackground.mock.calls.length).toBe(paid);
      const history = (
        await get(`/conversations/${conversation.id}`).expect(200)
      ).body as { conversation: Conversation };
      expect(
        history.conversation.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.text.includes('Auto approval') &&
            message.text.includes('Thay toàn bộ sản phẩm'),
        ),
      ).toBe(true);
      expect(
        await store.query<Step>('step', { runId: run.id, type: 'image' }),
      ).toEqual([]);
      await post(`/runs/${run.id}/cancel`);
    },
  );

  it('bounds automatic clarification rounds and falls back to manual choices', async () => {
    const conversation = (await post('/conversations', { title: 'Auto loop' }))
      .body as Conversation;
    const id = randomUUID();
    await post(`/conversations/${conversation.id}/messages`, {
      id,
      text: 'test-auto-loop: Tạo mockup',
      operation: 'mockup_ai',
      sourceIds: [source.id],
      targetIds: [target.id],
      approvalMode: 'auto',
    }).expect(202);
    await worker.tick();
    await wait(
      async () =>
        (await store.find<Step>('step', `${id}:plan`))?.state === 'done',
    );
    const run = await store.find<Run>('run', id);
    expect(run.state).toBe('needs_input');
    expect(run.autoApprovalRounds).toBe(2);
    expect(run.autoAnswers).toHaveLength(2);
    expect(run.questions).toEqual(['Xác nhận bước 3?']);
    await post(`/runs/${id}/start`, { updatedAt: run.updatedAt }).expect(409);
    await post(`/runs/${id}/cancel`);
  });

  it('validates approval modes and never accepts client-supplied automatic answers', async () => {
    const conversation = (
      await post('/conversations', { title: 'Approval validation' })
    ).body as Conversation;
    const input = {
      id: randomUUID(),
      text: 'Tạo thiết kế',
      operation: 'design',
    };
    await post(`/conversations/${conversation.id}/messages`, {
      ...input,
      approvalMode: 'full-access',
    }).expect(400);
    await post(`/conversations/${conversation.id}/messages`, {
      ...input,
      approvalMode: 'auto',
      autoAnswers: [{ question: 'fake', answer: 'fake' }],
    }).expect(400);
  });

  it('requires authentication and scopes assets to their owner', async () => {
    await request(http()).get('/api/agent/assets').expect(401);
    await get(`/assets/${source.id}/content`, otherToken).expect(404);
    const response = await get(`/assets/${source.id}/content`).expect(200);
    expect(Buffer.compare(response.body as Buffer, png)).toBe(0);
    const preview = await get(`/assets/${source.id}/preview`).expect(200);
    expect(preview.headers['content-type']).toContain('image/webp');
    expect((await sharp(preview.body as Buffer).metadata()).width).toBe(32);
    await get(`/assets/${source.id}/preview`, otherToken).expect(404);
    expect(encrypted.get(source.id)).not.toEqual(png);
    const responseAssets = await get('/assets').expect(200);
    expect(JSON.stringify(responseAssets.body)).not.toMatch(
      /storageKey|"iv"|"tag"/,
    );
    await post('/auth/users', {
      email: 'unauthorized@example.com',
      password: 'valid-long-password',
    }).expect(403);
  });
  it('rejects malformed files and crossed image roles', async () => {
    await request(http())
      .post('/api/agent/assets')
      .set('Authorization', `Bearer ${token}`)
      .field('kind', 'source')
      .attach('image', Buffer.from('<svg/>'), 'bad.png')
      .expect(400);
    const conversation = (await post('/conversations', { title: 'Roles' }))
      .body as Conversation;
    await post(`/conversations/${conversation.id}/messages`, {
      id: randomUUID(),
      text: 'Test role validation',
      operation: 'mockup_ai',
      sourceIds: [source.id],
      targetIds: [source.id],
    }).expect(400);
  });
  it('keeps an encrypted MongoDB image backup when R2 is unavailable', async () => {
    const put = jest.spyOn(app.get(R2Service), 'putAgentObject');
    put.mockRejectedValueOnce(new Error('Storage temporarily unavailable'));
    const asset = await app.get(AgentAssetsService).save(owner, png, {
      name: 'fallback.png',
      kind: 'source',
      category: 'Ornament',
    });
    expect(asset.storageKey).toMatch(/^mongo:/);
    expect(await store.readImageBackup(asset.storageKey.slice(6))).not.toEqual(
      png,
    );
    const response = await get(`/assets/${asset.id}/content`).expect(200);
    expect(Buffer.compare(response.body as Buffer, png)).toBe(0);
    await get(`/assets/${asset.id}/content`, otherToken).expect(404);
  });
  it('plans without generating paid images and forwards the exact approved prompt and both images', async () => {
    const { run } = await newRun();
    expect(ai.replaceBackground).not.toHaveBeenCalled();
    expect(run.items[0].prompt).toContain(MOCKUP_RULES);
    const final =
      run.items[0].prompt + '\nGiữ nguyên cả hai vị trí treo trong ảnh đích.';
    const edited = (
      await request(http())
        .patch(`/api/agent/runs/${run.id}/plan`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          updatedAt: run.updatedAt,
          items: [{ title: 'Kết quả', prompt: final }],
        })
        .expect(200)
    ).body as Run;
    await post(`/runs/${run.id}/start`, { updatedAt: edited.updatedAt }).expect(
      202,
    );
    await post(`/runs/${run.id}/start`, { updatedAt: edited.updatedAt }).expect(
      202,
    );
    await worker.tick();
    await wait(
      async () => (await store.find<Run>('run', run.id))?.state === 'review',
    );
    expect(ai.replaceBackground).toHaveBeenCalledTimes(1);
    const args = ai.replaceBackground.mock.calls[0] as unknown as [
      {
        instructions: string;
        productImage: { base64: string };
        backgroundImage: { base64: string };
      },
    ];
    expect(args[0].instructions).toBe(final);
    expect(Buffer.from(args[0].productImage.base64, 'base64')).toEqual(png);
    expect(Buffer.from(args[0].backgroundImage.base64, 'base64')).toEqual(
      targetPng,
    );
    const steps = await store.query<Step>('step', {
      runId: run.id,
      type: 'image',
    });
    await request(http())
      .patch(`/api/agent/assets/${steps[0].resultId}/review`)
      .set('Authorization', `Bearer ${token}`)
      .send({ review: 'approved' })
      .expect(200);
    expect((await store.find<Run>('run', run.id))?.state).toBe('completed');
  });
  it('persists changed image inputs, invalidates old approvals and keeps the old image/prompt snapshot', async () => {
    const { run } = await newRun();
    const inputs = {
      sourceIds: [target.id],
      targetIds: [source.id],
      templateIds: [],
    };
    const changed = (
      await request(http())
        .patch(`/api/agent/runs/${run.id}/inputs`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ...inputs, updatedAt: run.updatedAt })
        .expect(200)
    ).body as Run;
    expect(changed.pendingInputs).toEqual(inputs);
    expect(changed.sourceIds).toEqual(run.sourceIds);
    expect(changed.targetIds).toEqual(run.targetIds);
    expect(changed.items).toEqual(run.items);
    expect(changed.updatedAt).not.toBe(run.updatedAt);
    for (const updatedAt of [run.updatedAt, changed.updatedAt]) {
      const response = await post(`/runs/${run.id}/start`, {
        updatedAt,
      }).expect(409);
      expect((response.body as { code: string }).code).toBe(
        'AGENT_INPUTS_CHANGED',
      );
    }
    await request(http())
      .patch(`/api/agent/runs/${run.id}/plan`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        updatedAt: changed.updatedAt,
        items: [{ title: 'Old plan', prompt: 'Must not use the old images' }],
      })
      .expect(409);
    const detail = (
      await get(`/conversations/${run.conversationId}`).expect(200)
    ).body as { runs: Run[]; conversation: Conversation };
    expect(detail.runs[0].pendingInputs).toEqual(inputs);
    expect(
      detail.conversation.messages.some(
        (message) =>
          JSON.stringify(message.attachments) === JSON.stringify(inputs),
      ),
    ).toBe(true);
    expect(
      await store.query<Step>('step', { runId: run.id, type: 'image' }),
    ).toEqual([]);
    await post(`/runs/${run.id}/cancel`);
  });

  it('validates input ownership, image roles, revisions and refuses edits after generation is queued', async () => {
    const { run } = await newRun();
    const route = `/api/agent/runs/${run.id}/inputs`;
    const patch = (body: object, auth = token) =>
      request(http())
        .patch(route)
        .set('Authorization', `Bearer ${auth}`)
        .send(body);
    const input = {
      sourceIds: [target.id],
      targetIds: [source.id],
      templateIds: [],
      updatedAt: run.updatedAt,
    };
    await request(http()).patch(route).send(input).expect(401);
    await patch(input, otherToken).expect(404);
    await patch({ ...input, sourceIds: [randomUUID()] }).expect(404);
    await patch({ ...input, targetIds: [target.id] }).expect(400);
    await patch({ ...input, sourceIds: [target.id, target.id] }).expect(400);
    await patch({ ...input, updatedAt: '2000-01-01T00:00:00.000Z' }).expect(
      409,
    );
    await post(`/runs/${run.id}/start`, {
      updatedAt: run.updatedAt,
      inputs: {
        sourceIds: [target.id],
        targetIds: [source.id],
        templateIds: [],
      },
    }).expect(409);
    expect(
      (await store.find<Run>('run', run.id)).pendingInputs,
    ).toBeUndefined();
    await post(`/runs/${run.id}/start`, {
      updatedAt: run.updatedAt,
      inputs: {
        sourceIds: run.sourceIds,
        targetIds: run.targetIds,
        templateIds: run.templateIds,
      },
    }).expect(202);
    await patch(input).expect(409);
    await post(`/runs/${run.id}/cancel`);
  });

  it('replans the same workflow stage using pending images without generating against the obsolete plan', async () => {
    const workflow = (
      await post('/workflows', {
        name: 'Changed inputs workflow',
        description: '',
        archived: false,
        steps: [
          {
            name: 'Mockup',
            operation: 'mockup_ai',
            instructions: 'Thay sản phẩm vào cảnh tham chiếu.',
            source: 'initial',
            count: 1,
          },
        ],
      }).expect(201)
    ).body as CustomWorkflow;
    const conversation = (
      await post('/conversations', { title: 'Changed inputs workflow' })
    ).body as Conversation;
    const launched = (
      await post(`/workflows/${workflow.id}/launch`, {
        id: randomUUID(),
        conversationId: conversation.id,
        brief: 'Thay sản phẩm theo ảnh mới.',
        sourceIds: [source.id],
        targetIds: [target.id],
        templateIds: [],
        productType: 'POD',
        provider: 'shopaikey',
        approvalMode: 'auto',
      }).expect(201)
    ).body as { run: Run; execution: WorkflowExecution };
    await worker.tick();
    await wait(
      async () =>
        (await store.find<Run>('run', launched.run.id))?.state === 'draft',
    );
    const draft = await store.find<Run>('run', launched.run.id);
    const inputs = {
      sourceIds: [target.id],
      targetIds: [source.id],
      templateIds: [],
    };
    await request(http())
      .patch(`/api/agent/runs/${draft.id}/inputs`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...inputs, updatedAt: draft.updatedAt })
      .expect(200);
    const paid = ai.replaceBackground.mock.calls.length;
    const id = randomUUID();
    const replanned = (
      await post(`/workflow-executions/${launched.execution.id}/replan`, {
        id,
        answer: 'Phân tích lại toàn bộ ảnh mới.',
      }).expect(201)
    ).body as { run: Run; execution: WorkflowExecution };
    expect(replanned.run.sourceIds).toEqual(inputs.sourceIds);
    expect(replanned.run.targetIds).toEqual(inputs.targetIds);
    expect(replanned.run.approvalMode).toBe('auto');
    expect(replanned.run.pendingInputs).toBeUndefined();
    expect(replanned.execution.stage).toBe(0);
    expect(replanned.execution.runIds[0]).toBe(id);
    await worker.tick();
    await wait(
      async () => (await store.find<Run>('run', id))?.state === 'draft',
    );
    await post(`/runs/${draft.id}/start`, {
      updatedAt: draft.updatedAt,
    }).expect(409);
    expect(ai.replaceBackground.mock.calls.length).toBe(paid);
    await request(http())
      .patch(`/api/agent/runs/${draft.id}/inputs`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceIds: [],
        targetIds: [],
        templateIds: [],
        updatedAt: draft.updatedAt,
      })
      .expect(409);
    await post(`/runs/${id}/cancel`);
  });

  it('does not accept stale prompt edits or start using an unseen plan version', async () => {
    const { run } = await newRun();
    await request(http())
      .patch(`/api/agent/runs/${run.id}/plan`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        updatedAt: '2000-01-01T00:00:00.000Z',
        items: [{ title: 'Old', prompt: 'Wrong old prompt' }],
      })
      .expect(409);
    await post(`/runs/${run.id}/start`, {
      updatedAt: '2000-01-01T00:00:00.000Z',
    }).expect(409);
    await post(`/runs/${run.id}/cancel`).expect(201);
  });
  it('cancels queued work before any image request is submitted', async () => {
    const { run } = await newRun();
    await post(`/runs/${run.id}/start`, { updatedAt: run.updatedAt });
    const count = ai.replaceBackground.mock.calls.length;
    await post(`/runs/${run.id}/cancel`);
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ai.replaceBackground.mock.calls.length).toBe(count);
    expect(
      (await store.query<Step>('step', { runId: run.id, type: 'image' }))[0]
        .state,
    ).toBe('cancelled');
  });
  it('checks cancellation again after loading files and before submitting a paid image request', async () => {
    const { run } = await newRun();
    let started = false;
    let release: () => void = () => undefined;
    const blocked = new Promise<Buffer>((resolve) => {
      release = () => resolve(encrypted.get(source.id));
    });
    jest
      .spyOn(app.get(R2Service), 'getAgentObject')
      .mockImplementationOnce(() => {
        started = true;
        return blocked;
      });
    const before = ai.replaceBackground.mock.calls.length;
    await post(`/runs/${run.id}/start`, { updatedAt: run.updatedAt });
    await worker.tick();
    await wait(() => Promise.resolve(started));
    await post(`/runs/${run.id}/cancel`);
    release();
    await wait(
      async () =>
        (await store.query<Step>('step', { runId: run.id, type: 'image' }))[0]
          ?.state === 'cancelled',
    );
    expect(ai.replaceBackground.mock.calls.length).toBe(before);
  });
  it('keeps generated images if visual verification fails', async () => {
    const { run } = await newRun();
    const original = ai.agentJSON.getMockImplementation();
    ai.agentJSON.mockImplementation(async (prompt) => {
      if (prompt.startsWith('Kiểm tra'))
        throw new Error('Vision quota exceeded');
      return original(prompt);
    });
    await post(`/runs/${run.id}/start`, { updatedAt: run.updatedAt });
    await worker.tick();
    await wait(
      async () => (await store.find<Run>('run', run.id))?.state === 'review',
    );
    const step = (
      await store.query<Step>('step', { runId: run.id, type: 'image' })
    )[0];
    expect(
      (await store.find<Asset>('asset', step.resultId))?.checks?.visual,
    ).toBe('review');
    ai.agentJSON.mockImplementation(original);
  });
  it('never automatically repeats an image request whose provider timed out', async () => {
    const { run } = await newRun({ validateVisually: false });
    const before = ai.replaceBackground.mock.calls.length;
    ai.replaceBackground.mockRejectedValueOnce(
      new ApiError(504, 'AI_TIMEOUT', 'Model phản hồi quá thời gian.'),
    );
    await post(`/runs/${run.id}/start`, { updatedAt: run.updatedAt });
    await worker.tick();
    await wait(
      async () => (await store.find<Run>('run', run.id))?.state === 'failed',
    );
    const step = (
      await store.query<Step>('step', { runId: run.id, type: 'image' })
    )[0];
    expect(step.state).toBe('interrupted');
    expect(step.error).toContain('tính phí');
    await worker.tick();
    expect(ai.replaceBackground.mock.calls.length - before).toBe(1);
  });
  it('selects the design tool from chat and creates a bounded set of ideas', async () => {
    const { run } = await newRun({
      operation: 'auto',
      sourceIds: [],
      targetIds: [],
      count: 2,
      text: 'Tạo hai ý tưởng thiết kế T-shirt từ keyword camping',
      validateVisually: false,
    });
    expect(run.operation).toBe('design');
    expect(run.items).toHaveLength(2);
    const before = ai.generateImage.mock.calls.length;
    await post(`/runs/${run.id}/start`, { updatedAt: run.updatedAt });
    await worker.tick();
    await wait(
      async () => (await store.find<Run>('run', run.id))?.state === 'review',
    );
    expect(ai.generateImage.mock.calls.length - before).toBe(2);
  });
  it('renders a configured template without calling the image provider', async () => {
    const template = (
      await post('/templates', {
        name: 'T-shirt front',
        category: 'T-shirt',
        assetId: target.id,
        corners: [
          { x: 0.25, y: 0.25 },
          { x: 0.75, y: 0.25 },
          { x: 0.75, y: 0.75 },
          { x: 0.25, y: 0.75 },
        ],
      }).expect(201)
    ).body as { id: string };
    const { run } = await newRun({
      operation: 'mockup_template',
      targetIds: [],
      templateIds: [template.id],
      validateVisually: false,
    });
    const before =
      ai.replaceBackground.mock.calls.length +
      ai.generateImage.mock.calls.length +
      ai.editImage.mock.calls.length;
    await post(`/runs/${run.id}/start`, { updatedAt: run.updatedAt });
    await worker.tick();
    await wait(
      async () => (await store.find<Run>('run', run.id))?.state === 'review',
    );
    expect(
      ai.replaceBackground.mock.calls.length +
        ai.generateImage.mock.calls.length +
        ai.editImage.mock.calls.length,
    ).toBe(before);
    const step = (
      await store.query<Step>('step', { runId: run.id, type: 'image' })
    )[0];
    const result = await app.get(AgentAssetsService).read(owner, step.resultId);
    const pixels = await sharp(result.buffer).ensureAlpha().raw().toBuffer();
    expect(Array.from(pixels.subarray(0, 4))).toEqual([0, 0, 255, 255]);
    expect(
      Array.from(pixels.subarray((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4)),
    ).toEqual([255, 0, 0, 255]);
  });
  it('preserves a conversation and queued steps in a new store instance', async () => {
    const { run } = await newRun();
    await post(`/runs/${run.id}/start`, { updatedAt: run.updatedAt });
    const another = new AgentStore(
      new ConfigService({
        AGENT_ENABLED: true,
        MONGODB_URI: mongo.getUri(),
        MONGODB_DATABASE: 'agent_test',
      }),
    );
    await another.onModuleInit();
    try {
      expect((await another.get<Run>('run', run.id, owner)).state).toBe(
        'queued',
      );
      expect(
        (await another.query<Step>('step', { runId: run.id, type: 'image' }))[0]
          .state,
      ).toBe('queued');
    } finally {
      await another.onApplicationShutdown();
    }
    await post(`/runs/${run.id}/cancel`);
  });
  it('deduplicates the same submitted message and rejects cross-owner run access', async () => {
    const conversation = (await post('/conversations', { title: 'Idempotent' }))
      .body as Conversation;
    const input = {
      id: randomUUID(),
      text: 'Tạo một ý tưởng camping',
      operation: 'design',
      count: 1,
    };
    const responses = await Promise.all([
      post(`/conversations/${conversation.id}/messages`, input),
      post(`/conversations/${conversation.id}/messages`, input),
    ]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(
      (await store.messagePage(owner, conversation.id)).items.filter(
        (message) => message.role === 'user',
      ),
    ).toHaveLength(1);
    expect(await store.query<Step>('step', { runId: input.id })).toHaveLength(
      1,
    );
    await get(`/conversations/${conversation.id}`, otherToken).expect(404);
    await post(
      `/runs/${input.id}/start`,
      { updatedAt: new Date().toISOString() },
      otherToken,
    ).expect(404);
    await post(`/runs/${input.id}/cancel`);
  });
  it('keeps all messages beyond 200 and pages without gaps, duplicates or cross-owner access', async () => {
    const conversation = (
      await post('/conversations', { title: 'Full history' }).expect(201)
    ).body as Conversation;
    await Promise.all(
      Array.from({ length: 245 }, (_, index) =>
        store.appendMessage(conversation.id, owner, {
          id: `m-${String(index).padStart(4, '0')}`,
          role: index % 2 ? 'assistant' : 'user',
          text: `Tin nhắn ${index}`,
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    );
    await store.appendMessage(conversation.id, owner, {
      id: 'm-0000',
      role: 'user',
      text: 'duplicate',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const all: string[] = [];
    let before: string | null = null;
    do {
      const result = await get(
        `/conversations/${conversation.id}${before ? `?before=${before}` : ''}`,
      ).expect(200);
      const page = result.body as {
        conversation: Conversation;
        messagePage: { nextCursor: string | null };
      };
      all.unshift(...page.conversation.messages.map((message) => message.id));
      before = page.messagePage.nextCursor;
    } while (before);
    expect(all).toHaveLength(245);
    expect(new Set(all).size).toBe(245);
    expect(all[0]).toBe('m-0000');
    expect(all.at(-1)).toBe('m-0244');
    await get(`/conversations/${conversation.id}?before=invalid`).expect(400);
    await get(`/conversations/${conversation.id}`, otherToken).expect(404);
    expect(
      (await store.get<Conversation>('conversation', conversation.id, owner))
        .messages,
    ).toEqual([]);
    const another = new AgentStore(app.get(ConfigService));
    try {
      await another.onModuleInit();
      expect(
        (await another.messagePage(owner, conversation.id, undefined, 300))
          .items,
      ).toHaveLength(245);
    } finally {
      await another.onApplicationShutdown();
    }
  });
  it('migrates legacy embedded history idempotently before removing the embedded copy', async () => {
    const conversation = (
      await post('/conversations', { title: 'Legacy history' })
    ).body as Conversation;
    const messages: Conversation['messages'] = [
      {
        id: randomUUID(),
        role: 'user',
        text: 'Lịch sử cũ còn nguyên',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    await store.patch<Conversation>('conversation', conversation.id, owner, {
      messages,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const another = new AgentStore(app.get(ConfigService));
      try {
        await another.onModuleInit();
      } finally {
        await another.onApplicationShutdown();
      }
    }
    expect((await store.messagePage(owner, conversation.id)).items).toEqual(
      messages,
    );
    expect(
      (await store.get<Conversation>('conversation', conversation.id, owner))
        .messages,
    ).toEqual([]);
  });
  it('compacts old history, preserves pinned requirements and never consumes future context', async () => {
    const { conversation, run } = await newRun({
      operation: 'design',
      sourceIds: [],
      targetIds: [],
      count: 1,
    });
    await store.patch<Conversation>('conversation', conversation.id, owner, {
      pinnedRequirements: ['Giữ nguyên chữ POKEMON'],
    });
    for (let index = 0; index < 45; index++)
      await store.appendMessage(conversation.id, owner, {
        id: `old-${String(index).padStart(3, '0')}`,
        role: index % 2 ? 'assistant' : 'user',
        text: `Yêu cầu ${index}: giữ chữ POKEMON`,
        createdAt: '2025-01-01T00:00:00.000Z',
      });
    const context = new AgentContext(store, ai as unknown as AIService);
    const result = await context.prepare(run);
    expect(result.pinnedRequirements).toEqual(['Giữ nguyên chữ POKEMON']);
    expect(result.summary).toContain('POKEMON');
    expect(result.metadata.summarizedMessages).toBeGreaterThan(30);
    expect(result.history.length).toBeLessThanOrEqual(6);
    const memory = await store.find<ConversationMemory>(
      'conversation-memory',
      conversation.id,
    );
    expect(memory.messageCount).toBe(result.metadata.summarizedMessages);
    expect(
      (await store.messagePage(owner, conversation.id, undefined, 100)).items,
    ).toHaveLength(47);
    await store.patch<Run>('run', run.id, owner, { state: 'planning' });
    await app.get(AgentService).plan({ ...run, state: 'planning' });
    const planned = await store.find<Run>('run', run.id);
    expect(planned.items[0].prompt).toContain('YÊU CẦU GHIM CỦA HỘI THOẠI');
    expect(planned.items[0].prompt).toContain('Giữ nguyên chữ POKEMON');
    const data = JSON.parse(
      ai.agentJSON.mock.calls.at(-1)[0].split('DỮ LIỆU:\n')[1],
    ) as { pinnedRequirements: string[]; summary: string };
    expect(data.pinnedRequirements).toEqual(['Giữ nguyên chữ POKEMON']);
    expect(data.summary).toContain('POKEMON');
    await store.patch<ConversationMemory>(
      'conversation-memory',
      conversation.id,
      owner,
      { summary: 'FUTURE SECRET', through: '2099-01-01T00:00:00.000Z|future' },
    );
    const earlier = await context.prepare(run);
    expect(JSON.stringify(earlier)).not.toContain('FUTURE SECRET');
    expect(() => context.serialize({ research: 'x'.repeat(80000) })).toThrow(
      'Ngữ cảnh vượt',
    );
  });
  it('retains raw history and reports a compaction failure instead of silently dropping context', async () => {
    const { conversation, run } = await newRun({
      operation: 'design',
      sourceIds: [],
      targetIds: [],
      count: 1,
    });
    for (let index = 0; index < 20; index++)
      await store.appendMessage(conversation.id, owner, {
        id: `old-${index}`,
        role: 'user',
        text: 'Không được thay màu sản phẩm',
        createdAt: '2025-01-01T00:00:00.000Z',
      });
    ai.agentJSON.mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(
      new AgentContext(store, ai as unknown as AIService).prepare(run),
    ).rejects.toThrow('Chưa tóm tắt được hội thoại');
    expect(
      (await store.messagePage(owner, conversation.id, undefined, 100)).items,
    ).toHaveLength(22);
  });
  it('paginates conversation history with owner-scoped stable cursors', async () => {
    await Promise.all(
      Array.from({ length: 35 }, (_, index) =>
        app.get(AgentService).createConversation(owner, `History ${index}`),
      ),
    );
    const first = (await get('/history').expect(200)).body as {
      items: Conversation[];
      nextCursor: string;
    };
    expect(first.items).toHaveLength(30);
    const second = (
      await get(`/history?before=${first.nextCursor}`).expect(200)
    ).body as { items: Conversation[] };
    expect(second.items.length).toBeGreaterThan(0);
    expect(
      second.items.some((item) =>
        first.items.some((previous) => item.id === previous.id),
      ),
    ).toBe(false);
    const foreign = (
      await get(`/history?before=${first.nextCursor}`, otherToken).expect(200)
    ).body as { items: Conversation[] };
    expect(foreign.items.every((item) => item.owner !== owner)).toBe(true);
    await get('/history?before=invalid').expect(400);
  });
  it('runs a versioned employee workflow through approved previous outputs and prevents skipped stages', async () => {
    const input = {
      name: 'Design rồi mockup',
      description: 'Quy trình nhân viên',
      archived: false,
      steps: [
        {
          name: 'Hai thiết kế',
          operation: 'design',
          instructions: 'Tạo ý tưởng camping khác nhau.',
          source: 'initial',
          count: 2,
        },
        {
          name: 'Mockup',
          operation: 'mockup_ai',
          instructions: 'Chuyển thiết kế vào ảnh tham chiếu và giữ cảnh đích.',
          source: 'previous',
          count: 1,
        },
      ],
    };
    const workflow = (await post('/workflows', input).expect(201))
      .body as CustomWorkflow;
    expect(
      ((await get('/workflows', otherToken)).body as CustomWorkflow[]).some(
        (item) => item.id === workflow.id,
      ),
    ).toBe(false);
    const conversation = (
      await post('/conversations', { title: 'Workflow execution' })
    ).body as Conversation;
    const launch = {
      id: randomUUID(),
      conversationId: conversation.id,
      brief: 'Tạo bộ ảnh camping',
      sourceIds: [],
      targetIds: [target.id],
      templateIds: [],
      productType: 'T-shirt',
      provider: 'shopaikey',
      approvalMode: 'auto',
    };
    await post(`/workflows/${workflow.id}/launch`, launch, otherToken).expect(
      404,
    );
    const invalidLaunchId = randomUUID();
    ai.validateImageModel.mockRejectedValueOnce(
      new ApiError(400, 'AI_MODEL_INVALID', 'Model không dùng được.'),
    );
    await post(`/workflows/${workflow.id}/launch`, {
      ...launch,
      id: invalidLaunchId,
    }).expect(400);
    expect(
      await store.find<WorkflowExecution>(
        'workflow-execution',
        invalidLaunchId,
      ),
    ).toBeUndefined();
    const launched = (
      await post(`/workflows/${workflow.id}/launch`, launch).expect(201)
    ).body as { execution: WorkflowExecution; run: Run };
    const duplicate = (
      await post(`/workflows/${workflow.id}/launch`, launch).expect(201)
    ).body as { run: Run };
    expect(duplicate.run.id).toBe(launched.run.id);
    expect(launched.run.approvalMode).toBe('auto');
    expect(launched.execution.approvalMode).toBe('auto');
    await post(`/workflow-executions/${launched.execution.id}/stages/1`).expect(
      409,
    );
    await post(`/workflow-executions/${launched.execution.id}/stages/2`).expect(
      409,
    );
    const edited = await request(http())
      .patch(`/api/agent/workflows/${workflow.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...input, name: 'Workflow sửa', updatedAt: workflow.updatedAt })
      .expect(200);
    expect((edited.body as CustomWorkflow).revision).toBe(2);
    expect(
      (
        await store.find<WorkflowExecution>(
          'workflow-execution',
          launched.execution.id,
        )
      ).workflow.revision,
    ).toBe(1);
    await worker.tick();
    await wait(
      async () =>
        (await store.find<Run>('run', launched.run.id))?.state === 'draft',
    );
    const draft = await store.find<Run>('run', launched.run.id);
    await post(`/runs/${draft.id}/start`, {
      updatedAt: draft.updatedAt,
    }).expect(202);
    await worker.tick();
    await wait(
      async () => (await store.find<Run>('run', draft.id))?.state === 'review',
    );
    const steps = await store.query<Step>(
      'step',
      { runId: draft.id, type: 'image' },
      25,
    );
    for (const step of steps)
      await request(http())
        .patch(`/api/agent/assets/${step.resultId}/review`)
        .set('Authorization', `Bearer ${token}`)
        .send({ review: 'approved' })
        .expect(200);
    const next = (
      await post(`/workflow-executions/${launched.execution.id}/stages/1`, {
        approvalMode: 'manual',
      }).expect(201)
    ).body as { execution: WorkflowExecution; run: Run };
    expect(next.run.sourceIds.sort()).toEqual(
      steps.map((step) => step.resultId).sort(),
    );
    expect(next.run.count).toBe(2);
    expect(next.run.workflow.revision).toBe(1);
    expect(next.run.approvalMode).toBe('manual');
    expect(next.execution.approvalMode).toBe('manual');
    expect(next.execution.stage).toBe(1);
    const repeated = (
      await post(
        `/workflow-executions/${launched.execution.id}/stages/1`,
      ).expect(201)
    ).body as { run: Run };
    expect(repeated.run.id).toBe(next.run.id);
    await worker.tick();
    await wait(
      async () =>
        (await store.find<Run>('run', next.run.id))?.state === 'draft',
    );
    const nextDraft = await store.find<Run>('run', next.run.id);
    await post(`/runs/${next.run.id}/start`, {
      updatedAt: nextDraft.updatedAt,
    }).expect(202);
    await worker.tick();
    await wait(
      async () =>
        (await store.find<Run>('run', next.run.id))?.state === 'review',
    );
    const nextSteps = await store.query<Step>(
      'step',
      { runId: next.run.id, type: 'image' },
      25,
    );
    const retry = (
      await post(`/runs/${next.run.id}/retry`, {
        id: randomUUID(),
        stepIds: [nextSteps[0].id],
      }).expect(201)
    ).body as Run;
    expect(retry.sourceIds).toHaveLength(1);
    expect(
      (
        await store.find<WorkflowExecution>(
          'workflow-execution',
          launched.execution.id,
        )
      ).runIds[1],
    ).toBe(retry.id);
    const executionBeforeRepair = await store.find<WorkflowExecution>(
      'workflow-execution',
      launched.execution.id,
    );
    const interruptedRunIds = [...executionBeforeRepair.runIds];
    interruptedRunIds[1] = next.run.id;
    await store.patch<WorkflowExecution>(
      'workflow-execution',
      launched.execution.id,
      owner,
      { runIds: interruptedRunIds },
    );
    await post(`/runs/${next.run.id}/retry`, {
      id: retry.id,
      stepIds: [nextSteps[0].id],
    }).expect(201);
    expect(
      (
        await store.find<WorkflowExecution>(
          'workflow-execution',
          launched.execution.id,
        )
      ).runIds[1],
    ).toBe(retry.id);
    await store.patch<Run>('run', retry.id, owner, { state: 'failed' });
    const replanId = randomUUID();
    await post(`/workflow-executions/${launched.execution.id}/replan`, {
      id: randomUUID(),
      answer: 'Dùng ảnh mới',
      sourceIds: [randomUUID()],
    }).expect(404);
    const replanned = (
      await post(`/workflow-executions/${launched.execution.id}/replan`, {
        id: replanId,
        answer: 'Giữ nguyên chữ và màu sắc trên thiết kế',
        sourceIds: [source.id],
        targetIds: [target.id],
        approvalMode: 'manual',
      }).expect(201)
    ).body as { run: Run };
    expect(replanned.run.brief).toContain('Giữ nguyên chữ');
    expect(replanned.run.sourceIds).toEqual([source.id]);
    expect(replanned.run.targetIds).toEqual([target.id]);
    expect(replanned.run.approvalMode).toBe('manual');
    expect(
      (
        await store.find<WorkflowExecution>(
          'workflow-execution',
          launched.execution.id,
        )
      ).approvalMode,
    ).toBe('manual');
    const repeatedPlan = (
      await post(`/workflow-executions/${launched.execution.id}/replan`, {
        id: replanId,
        answer: 'Giữ nguyên chữ và màu sắc trên thiết kế',
      }).expect(201)
    ).body as { run: Run };
    expect(repeatedPlan.run.id).toBe(replanId);
    await post(
      `/workflow-executions/${launched.execution.id}/replan`,
      { id: randomUUID(), answer: 'Thử chéo tài khoản' },
      otherToken,
    ).expect(404);
    await post(`/runs/${replanId}/cancel`);
    await post('/workflows', {
      ...input,
      steps: [{ ...input.steps[0], source: 'previous' }],
    }).expect(400);
    await post('/workflows', {
      ...input,
      steps: [{ ...input.steps[0], operation: 'shell' }],
    }).expect(400);
  });
  it('claims jobs atomically across multiple workers and leaves uncertain calls interrupted', async () => {
    const runId = randomUUID();
    const fakeRun = store.create<Run>(owner, {
      conversationId: randomUUID(),
      brief: 'Lease',
      operation: 'design',
      state: 'running',
      provider: 'shopaikey',
      sourceIds: [],
      targetIds: [],
      templateIds: [],
      count: 1,
      productType: 'T-shirt',
      research: '',
      researchSources: [],
      summary: '',
      questions: [],
      items: [{ title: 'Lease', prompt: 'Lease' }],
      analyses: {},
      validateVisually: false,
      requestId: randomUUID(),
    });
    fakeRun.id = runId;
    await store.insert('run', fakeRun);
    const step = store.create<Step>(owner, {
      runId,
      type: 'image',
      state: 'queued',
      index: 0,
      input: fakeRun.items[0],
      requestId: randomUUID(),
    });
    step.id = `${runId}:image:0`;
    await store.insert('step', step);
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => store.claim()),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    await store.patch<Step>('step', step.id, owner, {
      leaseUntil: Date.now() - 1000,
    });
    await worker.tick();
    expect((await store.find<Step>('step', step.id))?.state).toBe(
      'interrupted',
    );
    expect((await store.find<Run>('run', runId))?.state).toBe('failed');
    await store.release(claims.find(Boolean));
  });
});
