import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AgentGuard, type AgentRequest } from '../agent/agent-auth.service';
import { AgentStore } from '../agent/agent.store';
import type { QueuedImageJob } from './image-task';
import { ImageJobsService } from './image-jobs.service';
import { TaskQueueService } from '../queue/task-queue.service';
import { ApiError } from './api-error';

@Controller('image-jobs')
@UseGuards(AgentGuard)
export class ImageJobsController {
  constructor(
    private readonly jobs: ImageJobsService,
    private readonly store: AgentStore,
    private readonly queue: TaskQueueService,
  ) {}
  @Get() @Header('Cache-Control', 'no-store') async list(
    @Req() req: AgentRequest,
  ) {
    const jobs = await this.store.list<QueuedImageJob>(
      'image-job',
      req.agentUser.id,
      100,
    );
    return jobs.map((job) => ({
      id: job.id,
      requestId: job.requestId,
      state: job.state,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      result: job.result,
      error: job.error,
    }));
  }
  @Get(':id') @Header('Cache-Control', 'no-store') get(
    @Req() req: AgentRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.jobs.get(id, req.agentUser.id);
  }
  @Post(':id/cancel') async cancel(
    @Req() req: AgentRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const owner = req.agentUser.id;
    await this.store.get<QueuedImageJob>('image-job', id, owner);
    const updated = await this.store.patch<QueuedImageJob>(
      'image-job',
      id,
      owner,
      {
        state: 'cancelled',
        error: {
          statusCode: 409,
          code: 'JOB_CANCELLED',
          message: 'Đã hủy trước khi gọi AI.',
          retryable: false,
        },
      },
      { state: { $in: ['queued', 'preparing'] } },
    );
    if (!updated)
      throw new ApiError(
        409,
        'JOB_ALREADY_STARTED',
        'Tác vụ đã bắt đầu hoặc kết thúc. Không thể hủy request đã gửi đến AI.',
      );
    await this.queue.release(`image-${id}`, owner);
    return this.jobs.get(id, owner);
  }
}
