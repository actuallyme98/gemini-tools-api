import type { Request } from 'express';
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { ApiError } from '../common/api-error';
import { externalServiceError } from '../common/external-service-error';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const ip = req.ip || 'unknown';

    const key = `rate:${ip}`;
    const limit = 5;

    let count: number;
    try {
      count = await this.redis.client.incr(key);
      if (count === 1) await this.redis.client.expire(key, 60);
    } catch (error) {
      throw externalServiceError('redis', error);
    }

    if (count > limit) {
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Bạn đã gửi quá nhiều yêu cầu trong một phút. Vui lòng chờ rồi thử lại.',
        { retryable: true, retryAfterSeconds: 60 },
      );
    }

    return true;
  }
}
