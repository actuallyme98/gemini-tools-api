import { Controller, Get, Optional } from '@nestjs/common';
import { TaskQueueService } from './queue/task-queue.service';
import { ApiError } from './common/api-error';

@Controller('health')
export class HealthController {
  constructor(@Optional() private readonly queue?: TaskQueueService) {}
  @Get()
  async check() {
    if (this.queue?.enabled && !(await this.queue.metrics()).available)
      throw new ApiError(503, 'QUEUE_UNAVAILABLE', 'Hàng đợi chưa sẵn sàng.');
    return { status: 'ok' };
  }
}
