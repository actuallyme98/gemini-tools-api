import type { Request } from 'express';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { ApiError } from '../common/api-error';
import { externalServiceError } from '../common/external-service-error';

@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(private redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();

    const userId = req.get('x-user-id') || req.ip || 'unknown';

    const today = new Date().toISOString().slice(0, 10);
    const key = `quota:${userId}:${today}`;

    const DAILY_LIMIT = 5;

    try {
      const used = Number((await this.redis.client.get(key)) || 0);
      if (used >= DAILY_LIMIT)
        throw new ApiError(
          429,
          'DAILY_QUOTA_EXCEEDED',
          'Bạn đã dùng hết quota tạo ảnh trong ngày. Vui lòng thử lại vào ngày mai.',
        );
      await this.redis.client.incr(key);
      await this.redis.client.expire(key, 86400);
    } catch (error) {
      throw externalServiceError('redis', error);
    }

    return true;
  }
}
