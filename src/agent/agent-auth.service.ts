import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request } from 'express';
import { ApiError } from '../common/api-error';
import { AgentStore } from './agent.store';
import type { AgentUser, Session } from './agent.types';

const derive = promisify(scrypt);
const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export type AgentRequest = Request & { agentUser: AgentUser };
export const publicUser = (user: AgentUser) => ({
  id: user.id,
  email: user.email,
  role: user.role,
});

@Injectable()
export class AgentAuthService {
  constructor(
    private readonly store: AgentStore,
    private readonly config: ConfigService,
  ) {}
  async createUser(email: string, password: string, role: AgentUser['role']) {
    const normalized = email.trim().toLowerCase();
    if (
      (await this.store.query<AgentUser>('user', { email: normalized })).length
    )
      throw new ApiError(409, 'AGENT_USER_EXISTS', 'Tài khoản đã tồn tại.');
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt, 64)) as Buffer;
    const user = this.store.create<AgentUser>('', {
      email: normalized,
      passwordHash: `${salt}:${hash.toString('hex')}`,
      role,
    });
    user.owner = user.id;
    try {
      return publicUser(await this.store.insert('user', user));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 11000)
        throw new ApiError(409, 'AGENT_USER_EXISTS', 'Tài khoản đã tồn tại.');
      throw error;
    }
  }
  async login(email: string, password: string, ip: string) {
    const now = Date.now();
    const key = digest(`${ip}:${email.trim().toLowerCase()}`);
    if (
      (await this.store.loginAttempt(digest(ip))) > 60 ||
      (await this.store.loginAttempt(key)) > 6
    )
      throw new ApiError(
        429,
        'AGENT_LOGIN_LIMIT',
        'Thử đăng nhập quá nhiều lần. Vui lòng thử lại sau 15 phút.',
      );
    const user = (
      await this.store.query<AgentUser>('user', {
        email: email.trim().toLowerCase(),
      })
    )[0];
    const [salt, expected] = (
      user?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`
    ).split(':');
    const hash = (await derive(password, salt, 64)) as Buffer;
    if (!user || !timingSafeEqual(hash, Buffer.from(expected, 'hex')))
      throw new ApiError(
        401,
        'AGENT_LOGIN_FAILED',
        'Email hoặc mật khẩu không đúng.',
      );
    await this.store.remove('login-rate', key);
    const token = randomBytes(32).toString('hex');
    const session = this.store.create<Session>(user.id, {
      expiresAt:
        now + this.config.get<number>('AGENT_SESSION_HOURS', 24) * 3600000,
    });
    session.id = digest(token);
    await this.store.insert('session', session);
    return { token, user: publicUser(user), expiresAt: session.expiresAt };
  }
  async authenticate(header?: string) {
    const token = header?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const session = token
      ? await this.store.find<Session>('session', digest(token))
      : undefined;
    const user =
      session && session.expiresAt > Date.now()
        ? await this.store.find<AgentUser>('user', session.owner)
        : undefined;
    if (!user)
      throw new ApiError(
        401,
        'AGENT_AUTH_REQUIRED',
        'Vui lòng đăng nhập để sử dụng Agent.',
      );
    return user;
  }
  async logout(header: string) {
    const token = header?.slice(7);
    if (token) await this.store.remove('session', digest(token));
  }
}

@Injectable()
export class AgentGuard implements CanActivate {
  constructor(private readonly auth: AgentAuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AgentRequest>();
    request.agentUser = await this.auth.authenticate(
      request.headers.authorization,
    );
    return true;
  }
}
