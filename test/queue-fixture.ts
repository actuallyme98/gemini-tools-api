import { ConfigService } from '@nestjs/config';
import type { INestApplication, ExecutionContext } from '@nestjs/common';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomBytes, randomUUID } from 'node:crypto';
import { AgentAuthService } from '../src/agent/agent-auth.service';
import type { QueueTask } from '../src/queue/task-queue.service';

// Only contract tests replace Redis dispatch; queue.e2e-spec uses real Redis/BullMQ.
export class TestTaskQueue {
  enabled = false;
  private handlers = new Map<string, (task: QueueTask) => Promise<void>>();
  private active = new Set<string>();
  register(kind: string, handler: (task: QueueTask) => Promise<void>) {
    this.handlers.set(kind, handler);
  }
  reserve = jest.fn(() => Promise.resolve());
  release = jest.fn(() => Promise.resolve());
  touch = jest.fn(() => Promise.resolve());
  metrics = () =>
    Promise.resolve({
      available: true,
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      concurrency: 3,
      perUserConcurrency: 2,
    });
  publish(task: QueueTask) {
    const key = `${task.kind}:${task.id}`;
    if (!this.active.has(key)) {
      this.active.add(key);
      const handler = this.handlers.get(task.kind);
      if (handler)
        void handler(task)
          .catch(() => undefined)
          .finally(() => this.active.delete(key));
    }
    return Promise.resolve();
  }
}
export async function queueFixture(config = new ConfigService()) {
  const mongo = await MongoMemoryServer.create();
  config.set('AGENT_ENABLED', true);
  config.set('QUEUE_ENABLED', false);
  config.set('MONGODB_URI', mongo.getUri());
  config.set(
    'MONGODB_DATABASE',
    'queue_contract_' + randomUUID().replaceAll('-', ''),
  );
  config.set('AGENT_ASSET_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  const queue = new TestTaskQueue();
  let user: { id: string; email: string; role: 'admin' | 'designer' };
  return {
    config,
    queue,
    guard: {
      canActivate(context: ExecutionContext) {
        context
          .switchToHttp()
          .getRequest<{ agentUser: typeof user }>().agentUser = user;
        return true;
      },
    },
    async seed(app: INestApplication) {
      user = await app
        .get(AgentAuthService)
        .createUser('test@example.com', 'queue-test-password', 'designer');
    },
    close: () => mongo.stop(),
  };
}
