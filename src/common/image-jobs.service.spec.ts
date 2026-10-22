import { ConfigService } from '@nestjs/config';
import { ImageJobsService } from './image-jobs.service';
import { AgentStore } from '../agent/agent.store';
import { TaskQueueService } from '../queue/task-queue.service';
import { ApiError } from './api-error';

describe('Durable image job admission', () => {
  it('does not reserve or enqueue work for a reused ID owned by another employee', async () => {
    const reserve = jest.fn();
    const publish = jest.fn();
    const jobs = new ImageJobsService(
      {
        find: jest
          .fn()
          .mockResolvedValue({ owner: 'another-user', inputHash: 'different' }),
      } as unknown as AgentStore,
      { reserve, publish } as unknown as TaskQueueService,
      new ConfigService(),
    );
    await expect(
      jobs.create(
        { operation: 'mockup', images: [], prompt: 'test' },
        'request',
        'employee',
        'same-id',
      ),
    ).rejects.toThrow(ApiError);
    expect(reserve).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it('returns unavailable before saving any input when Redis admission fails', async () => {
    const ensure = jest.fn();
    const reserve = jest.fn().mockRejectedValue(new Error('Queue unavailable'));
    const jobs = new ImageJobsService(
      {
        find: jest.fn().mockResolvedValue(undefined),
        ensure,
      } as unknown as AgentStore,
      { reserve } as unknown as TaskQueueService,
      new ConfigService(),
    );
    await expect(
      jobs.create({ operation: 'analyze', images: [] }, 'request', 'employee'),
    ).rejects.toThrow('Queue unavailable');
    expect(ensure).not.toHaveBeenCalled();
  });
});
