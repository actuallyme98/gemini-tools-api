import {
  CanActivate,
  ExecutionContext,
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const ip = req.ip || 'unknown';

    const key = `rate:${ip}`;
    const limit = 5;

    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, 60);
    }

    if (count > limit) {
      throw new BadRequestException('Too many requests, slow down');
    }

    return true;
  }
}
