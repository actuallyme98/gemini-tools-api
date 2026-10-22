import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { OAuth2Client } from 'google-auth-library';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import { AgentAuthController } from '../src/agent/agent.controller';
import { AgentAuthService, AgentGuard } from '../src/agent/agent-auth.service';
import { AgentStore } from '../src/agent/agent.store';
import { ApiExceptionFilter } from '../src/common/api-exception.filter';
import type {
  AgentUser,
  CompanySettings,
  Session,
} from '../src/agent/agent.types';

describe('Google sign-in (real signed tokens and MongoDB)', () => {
  let mongo: MongoMemoryServer,
    app: INestApplication,
    store: AgentStore,
    auth: AgentAuthService;
  const clientId = 'test-client.apps.googleusercontent.com';
  const config = new ConfigService({
    AGENT_ENABLED: true,
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_ALLOWED_DOMAINS: 'lcgmedia.uk,second.example',
  });
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const post = (path: string, body: object = {}) =>
    request(http())
      .post('/api/agent/auth' + path)
      .send(body);
  const challenge = async () => {
    const response = await post('/google/challenge').expect(200);
    return (response.body as { nonce: string }).nonce;
  };
  const token = (nonce: string, claims: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'test' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: clientId,
        iat: now,
        exp: now + 3600,
        sub: randomUUID(),
        email: `designer-${randomUUID()}@lcgmedia.uk`,
        email_verified: true,
        hd: 'lcgmedia.uk',
        nonce,
        ...claims,
      }),
    ).toString('base64url');
    const content = `${header}.${payload}`;
    return `${content}.${sign('RSA-SHA256', Buffer.from(content), keys.privateKey).toString('base64url')}`;
  };
  beforeAll(async () => {
    // Replace only Google's key download. Signature/issuer/audience/time checks still run.
    jest
      .spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync')
      .mockResolvedValue({
        certs: {
          test: keys.publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
        },
        format: 'PEM' as Awaited<
          ReturnType<OAuth2Client['getFederatedSignonCertsAsync']>
        >['format'],
      });
    mongo = await MongoMemoryServer.create();
    config.set('MONGODB_URI', mongo.getUri());
    config.set('MONGODB_DATABASE', 'google_auth_test');
    const module = await Test.createTestingModule({
      controllers: [AgentAuthController],
      providers: [
        AgentStore,
        AgentAuthService,
        AgentGuard,
        { provide: ConfigService, useValue: config },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    store = app.get(AgentStore);
    auth = app.get(AgentAuthService);
    const settings = store.create<CompanySettings>('', {
      name: 'LCG Media',
      protectedAdminId: 'root',
      googleAllowedDomains: ['lcgmedia.uk', 'second.example'],
      googleAutoProvision: true,
      queuePaused: false,
    });
    settings.id = 'company';
    await store.insert('company-settings', settings);
  });
  afterAll(async () => {
    await app?.close();
    await store?.onApplicationShutdown();
    await mongo?.stop();
    jest.restoreAllMocks();
  });
  it('fails closed without a client or database domain policy, ignoring environment domains', async () => {
    config.set('GOOGLE_CLIENT_ID', '');
    await post('/google/challenge').expect(503);
    config.set('GOOGLE_CLIENT_ID', clientId);
    await store.patch<CompanySettings>('company-settings', 'company', '', {
      googleAllowedDomains: [],
    });
    await post('/google/challenge').expect(503);
    await post('/google', {
      credential: 'untrusted',
      nonce: 'a'.repeat(64),
    }).expect(503);
    const status = await request(http())
      .get('/api/agent/auth/status')
      .expect(200);
    expect(status.body as unknown).toMatchObject({
      google: { enabled: false, allowedDomains: [] },
    });
    await store.patch<CompanySettings>('company-settings', 'company', '', {
      googleAllowedDomains: ['lcgmedia.uk', 'second.example'],
    });
  });
  it('creates a designer without a password and returns an ordinary working session', async () => {
    const nonce = await challenge();
    const email = 'new@lcgmedia.uk';
    const response = await post('/google', {
      credential: token(nonce, { email, sub: 'new-google-sub' }),
      nonce,
    }).expect(200);
    const data = response.body as {
      token: string;
      user: { id: string; role: string };
      expiresAt: number;
    };
    expect(data.user.role).toBe('designer');
    expect(data.expiresAt).toBeGreaterThan(Date.now());
    const user = await store.find<AgentUser>('user', data.user.id);
    expect(user).toMatchObject({
      email,
      googleSub: 'new-google-sub',
      owner: data.user.id,
    });
    expect(user?.passwordHash).toBeUndefined();
    const me = await request(http())
      .get('/api/agent/auth/me')
      .set('Authorization', `Bearer ${data.token}`)
      .expect(200);
    expect(me.body as unknown).toEqual(data.user);
    expect(me.body as object).not.toHaveProperty('googleSub');
    await post('/login', { email, password: 'password-not-created' }).expect(
      401,
    );
    await request(http())
      .post('/api/agent/auth/logout')
      .set('Authorization', `Bearer ${data.token}`)
      .expect(204);
    await request(http())
      .get('/api/agent/auth/me')
      .set('Authorization', `Bearer ${data.token}`)
      .expect(401);
  });
  it('links existing accounts without changing their ownership, role or password', async () => {
    const admin = await auth.createUser(
      'admin@lcgmedia.uk',
      'existing-admin-password',
      'admin',
    );
    const before = await store.find<AgentUser>('user', admin.id);
    const nonce = await challenge();
    const result = await post('/google', {
      credential: token(nonce, {
        email: 'ADMIN@LCGMEDIA.UK',
        sub: 'admin-sub',
      }),
      nonce,
    }).expect(200);
    expect((result.body as { user: unknown }).user).toEqual(admin);
    expect((await store.find<AgentUser>('user', admin.id))?.passwordHash).toBe(
      before?.passwordHash,
    );
    await post('/login', {
      email: admin.email,
      password: 'existing-admin-password',
    }).expect(200);
  });
  it('supports a second allowed domain', async () => {
    const nonce = await challenge();
    await post('/google', {
      credential: token(nonce, {
        email: 'staff@second.example',
        hd: 'second.example',
      }),
      nonce,
    }).expect(200);
  });
  it.each([
    { email: 'outside@gmail.com', hd: undefined },
    { email: 'staff@lcgmedia.uk.evil.com', hd: 'lcgmedia.uk.evil.com' },
    { email: 'staff@lcgmedia-other.com', hd: 'lcgmedia-other.com' },
    { email: 'lcgmedia.uk@gmail.com', hd: undefined },
    { email: 'staff@sub.lcgmedia.uk', hd: 'sub.lcgmedia.uk' },
    { email: 'staff@lcgmedia.uk', hd: undefined },
    { email: 'staff@lcgmedia.uk', hd: 'evil.com' },
  ])('rejects unapproved or non-Workspace domains: %j', async (claims) => {
    const nonce = await challenge();
    const result = await post('/google', {
      credential: token(nonce, claims),
      nonce,
    }).expect(403);
    expect(result.body as unknown).toMatchObject({
      code: 'AGENT_GOOGLE_DOMAIN_DENIED',
    });
  });
  it.each([
    { aud: 'other-client.apps.googleusercontent.com' },
    { iss: 'https://evil.example' },
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { email_verified: false },
    { sub: '' },
    { nonce: 'b'.repeat(64) },
  ])('rejects invalid identity claims: %j', async (claims) => {
    const nonce = await challenge();
    const credential = token(nonce, claims);
    const result = await post('/google', { credential, nonce }).expect(401);
    expect(JSON.stringify(result.body)).not.toContain(credential);
  });
  it('rejects a forged signature', async () => {
    const nonce = await challenge();
    const parts = token(nonce).split('.');
    parts[2] = Buffer.alloc(256).toString('base64url');
    await post('/google', { credential: parts.join('.'), nonce }).expect(401);
  });
  it('consumes a nonce atomically so simultaneous replays create only one session', async () => {
    const nonce = await challenge();
    const body = { credential: token(nonce), nonce };
    const results = await Promise.all([
      post('/google', body),
      post('/google', body),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
  });
  it('rejects an expired nonce even before Mongo TTL cleanup runs', async () => {
    const nonce = await challenge();
    const id = createHash('sha256').update(nonce).digest('hex');
    await store.patch<Session>('google-nonce', id, '', {
      expiresAt: Date.now() - 1,
    });
    await post('/google', { credential: token(nonce), nonce }).expect(401);
  });
  it('does not replace an already linked Google identity', async () => {
    const nonce = await challenge();
    await post('/google', {
      credential: token(nonce, {
        email: 'new@lcgmedia.uk',
        sub: 'attacker-sub',
      }),
      nonce,
    }).expect(409);
  });
  it('keeps the same user id when Google changes an allowed email for the same subject', async () => {
    const before = (
      await store.query<AgentUser>('user', { googleSub: 'new-google-sub' })
    )[0];
    const nonce = await challenge();
    const result = await post('/google', {
      credential: token(nonce, {
        email: 'renamed@second.example',
        hd: 'second.example',
        sub: 'new-google-sub',
      }),
      nonce,
    }).expect(200);
    expect((result.body as { user: { id: string } }).user.id).toBe(before.id);
  });
  it('validates request shape and rate limits before token verification', async () => {
    await post('/google', { credential: 'invalid', nonce: {} }).expect(400);
    await post('/google', {
      credential: 'invalid',
      nonce: 'a'.repeat(64),
      role: 'admin',
    }).expect(400);
    const spy = jest.spyOn(store, 'loginAttempt').mockResolvedValueOnce(61);
    await post('/google', {
      credential: 'invalid',
      nonce: 'a'.repeat(64),
    }).expect(429);
    spy.mockRestore();
  });
  it('honors the persisted invitation-only policy for Google sign-in', async () => {
    const settings = store.create<CompanySettings>('', {
      name: 'LCG Media',
      protectedAdminId: 'root',
      googleAllowedDomains: ['lcgmedia.uk', 'second.example'],
      googleAutoProvision: false,
      queuePaused: false,
    });
    settings.id = 'company';
    await store.patch<CompanySettings>('company-settings', settings.id, '', {
      googleAutoProvision: false,
    });
    const nonce = await challenge();
    await post('/google', {
      credential: token(nonce, { email: 'uninvited@lcgmedia.uk' }),
      nonce,
    }).expect(403);
    const invited = await auth.createUser(
      'invited@lcgmedia.uk',
      'invited-user-password',
      'designer',
    );
    const invitedNonce = await challenge();
    const result = await post('/google', {
      credential: token(invitedNonce, {
        email: invited.email,
        sub: 'invited-sub',
      }),
      nonce: invitedNonce,
    }).expect(200);
    expect((result.body as { user: { id: string } }).user.id).toBe(invited.id);
    await store.patch<AgentUser>('user', invited.id, invited.id, {
      disabled: true,
    });
    const lockedNonce = await challenge();
    await post('/google', {
      credential: token(lockedNonce, {
        email: invited.email,
        sub: 'invited-sub',
      }),
      nonce: lockedNonce,
    }).expect(403);
  });
});
