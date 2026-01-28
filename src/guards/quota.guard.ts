import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(private redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();

    const userId = req.headers['x-user-id'] || req.ip;

    const today = new Date().toISOString().slice(0, 10);
    const key = `quota:${userId}:${today}`;

    const DAILY_LIMIT = 5;

    const used = Number((await this.redis.client.get(key)) || 0);

    if (used >= DAILY_LIMIT) {
      throw new ForbiddenException('Daily image quota exceeded');
    }

    await this.redis.client.incr(key);
    await this.redis.client.expire(key, 86400);

    return true;
  }
}
