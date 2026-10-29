import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { StudioModule } from '../src/studio/studio.module';
import { StudioService } from '../src/studio/studio.service';
import { AIService } from '../src/ai/ai.service';
import { R2Service } from '../src/r2/r2.service';
import { AuditLogService } from '../src/audit/audit-log.service';
import { TaskQueueService } from '../src/queue/task-queue.service';
import { queueFixture } from './queue-fixture';

describe('Studio production module wiring (isolated dependencies)', () => {
  it('boots the real Studio/Agent/AI/identity module graph without connecting to production', async () => {
    const fixture = await queueFixture();
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        StudioModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(fixture.config)
      .overrideProvider(AIService)
      .useValue({})
      .overrideProvider(R2Service)
      .useValue({})
      .overrideProvider(AuditLogService)
      .useValue({
        run: (_context: unknown, callback: () => unknown) => callback(),
        write: jest.fn().mockResolvedValue(undefined),
      })
      .overrideProvider(TaskQueueService)
      .useValue(fixture.queue)
      .compile();
    const app = module.createNestApplication({ logger: false });
    try {
      await app.init();
      await fixture.seed(app);
      expect(app.get(StudioService)).toBeInstanceOf(StudioService);
    } finally {
      await app.close();
      await fixture.close();
    }
  }, 60000);
});
