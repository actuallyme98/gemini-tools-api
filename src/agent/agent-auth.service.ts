import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request } from 'express';
import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { ApiError } from '../common/api-error';
import { AgentStore } from './agent.store';
import type { AgentUser, CompanySettings, Session } from './agent.types';
import { adminAction } from './admin-audit';

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
  private readonly google = new OAuth2Client();
  constructor(
    private readonly store: AgentStore,
    private readonly config: ConfigService,
  ) {}
  async googleConfiguration() {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID', '').trim();
    const settings = this.store.enabled
      ? await this.store.find<CompanySettings>('company-settings', 'company')
      : undefined;
    const allowedDomains = settings?.googleAllowedDomains ?? [];
    const enabled =
      this.store.enabled && !!clientId && allowedDomains.length > 0;
    return {
      enabled,
      clientId: enabled ? clientId : undefined,
      allowedDomains,
    };
  }
  private async requireGoogle() {
    const config = await this.googleConfiguration();
    if (!config.enabled)
      throw new ApiError(
        503,
        'AGENT_GOOGLE_DISABLED',
        'Đăng nhập Google chưa được cấu hình.',
      );
    return config;
  }
  private async googleRateLimit(ip: string, action: string) {
    if ((await this.store.loginAttempt(digest(`google:${action}:${ip}`))) > 60)
      throw new ApiError(
        429,
        'AGENT_LOGIN_LIMIT',
        'Thử đăng nhập quá nhiều lần. Vui lòng thử lại sau 15 phút.',
      );
  }
  async googleChallenge(ip: string) {
    await this.requireGoogle();
    await this.googleRateLimit(ip, 'challenge');
    const nonce = randomBytes(32).toString('hex');
    const record = this.store.create<Session>('', {
      expiresAt: Date.now() + 10 * 60000,
    });
    record.id = digest(nonce);
    await this.store.insert('google-nonce', record);
    return { nonce, expiresAt: record.expiresAt };
  }
  async googleLogin(credential: string, nonce: string, ip: string) {
    const config = await this.requireGoogle();
    await this.googleRateLimit(ip, 'login');
    let payload: (TokenPayload & { nonce?: string }) | undefined;
    try {
      const ticket = await this.google.verifyIdToken({
        idToken: credential,
        audience: config.clientId,
      });
      payload = ticket.getPayload();
    } catch {
      // Never expose Google's raw verification error: it can contain the ID token.
      throw new ApiError(
        401,
        'AGENT_GOOGLE_TOKEN_INVALID',
        'Không xác minh được đăng nhập Google. Vui lòng thử lại.',
      );
    }
    if (
      !payload?.sub ||
      !payload.email ||
      payload.email_verified !== true ||
      payload.exp <= Date.now() / 1000 ||
      payload.nonce !== nonce
    )
      throw new ApiError(
        401,
        'AGENT_GOOGLE_TOKEN_INVALID',
        'Thông tin đăng nhập Google không hợp lệ hoặc đã hết hạn.',
      );
    const email = payload.email.toLowerCase();
    const parts = email.split('@');
    const domain = parts[1];
    // For company email, require Google's signed Workspace domain, not an email substring.
    if (
      parts.length !== 2 ||
      !parts[0] ||
      !config.allowedDomains.includes(domain) ||
      (domain !== 'gmail.com' && payload.hd?.toLowerCase() !== domain)
    )
      throw new ApiError(
        403,
        'AGENT_GOOGLE_DOMAIN_DENIED',
        'Email Google không thuộc domain được phép hoặc không phải tài khoản Google Workspace của tổ chức.',
      );
    if (!(await this.store.consumeGoogleNonce(digest(nonce))))
      throw new ApiError(
        401,
        'AGENT_GOOGLE_NONCE_INVALID',
        'Lượt đăng nhập đã hết hạn hoặc đã được sử dụng. Vui lòng thử lại.',
      );
    let user =
      (
        await this.store.query<AgentUser>('user', { googleSub: payload.sub }, 1)
      )[0] ?? (await this.store.query<AgentUser>('user', { email }, 1))[0];
    if (!user) {
      if (
        (await this.store.find<CompanySettings>('company-settings', 'company'))
          ?.googleAutoProvision === false
      )
        throw new ApiError(
          403,
          'AGENT_INVITATION_REQUIRED',
          'Tài khoản chưa được cấp quyền. Vui lòng liên hệ quản trị viên.',
        );
      const created = this.store.create<AgentUser>('', {
        email,
        googleSub: payload.sub,
        role: 'designer',
      });
      created.owner = created.id;
      try {
        user = await this.store.insert('user', created);
      } catch (error) {
        if (
          !(error instanceof Error && 'code' in error && error.code === 11000)
        )
          throw error;
        user = (await this.store.query<AgentUser>('user', { email }, 1))[0];
      }
    }
    if (!user || (user.googleSub && user.googleSub !== payload.sub))
      throw new ApiError(
        409,
        'AGENT_GOOGLE_ACCOUNT_CONFLICT',
        'Email đã được liên kết với tài khoản Google khác. Liên hệ quản trị viên.',
      );
    if (!user.googleSub || user.email !== email) {
      try {
        user = await this.store.patch<AgentUser>(
          'user',
          user.id,
          user.owner,
          { googleSub: payload.sub, email },
          {
            email: user.email,
            googleSub: user.googleSub ?? { $exists: false },
          },
        );
      } catch (error) {
        if (
          !(error instanceof Error && 'code' in error && error.code === 11000)
        )
          throw error;
        user = undefined;
      }
      if (!user)
        throw new ApiError(
          409,
          'AGENT_GOOGLE_ACCOUNT_CONFLICT',
          'Tài khoản vừa thay đổi. Vui lòng đăng nhập lại hoặc liên hệ quản trị viên.',
        );
    }
    return this.createSession(user);
  }
  async createUser(
    email: string,
    password: string,
    role: AgentUser['role'],
    actor?: AgentUser,
  ): Promise<ReturnType<typeof publicUser>> {
    if (actor)
      return adminAction(
        this.store,
        actor,
        'account.create',
        email.toLowerCase(),
        { role },
        () => this.createUser(email, password, role),
      );
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
    if (
      !user?.passwordHash ||
      !timingSafeEqual(hash, Buffer.from(expected, 'hex'))
    )
      throw new ApiError(
        401,
        'AGENT_LOGIN_FAILED',
        'Email hoặc mật khẩu không đúng.',
      );
    await this.store.remove('login-rate', key);
    return this.createSession(user);
  }
  private async createSession(user: AgentUser) {
    if (user.disabled)
      throw new ApiError(
        403,
        'AGENT_ACCOUNT_DISABLED',
        'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.',
      );
    const token = randomBytes(32).toString('hex');
    const session = this.store.create<Session>(user.id, {
      authVersion: user.authVersion ?? 0,
      expiresAt:
        Date.now() +
        this.config.get<number>('AGENT_SESSION_HOURS', 24) * 3600000,
    });
    session.id = digest(token);
    await this.store.insert('session', session);
    await this.store.patch<AgentUser>('user', user.id, user.owner, {
      lastLoginAt: new Date().toISOString(),
    });
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
    if (
      !user ||
      user.disabled ||
      (session?.authVersion ?? 0) !== (user.authVersion ?? 0)
    )
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

@Injectable()
export class AgentAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    context
      .switchToHttp()
      .getResponse<{ setHeader: (name: string, value: string) => void }>()
      .setHeader('Cache-Control', 'no-store');
    if (
      context.switchToHttp().getRequest<AgentRequest>().agentUser?.role !==
      'admin'
    )
      throw new ApiError(
        403,
        'AGENT_ADMIN_REQUIRED',
        'Chỉ quản trị viên được truy cập trang quản trị.',
      );
    return true;
  }
}
