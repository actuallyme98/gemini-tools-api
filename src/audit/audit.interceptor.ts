import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { AuditLogService } from './audit-log.service';
import { sanitizeErrorMessage } from '../common/error-sanitizer';
import type { AgentRequest } from '../agent/agent-auth.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const trace = {
      requestId: randomUUID(),
      method: request.method,
      path: request.path,
      ...((request as AgentRequest).agentUser
        ? {
            actorEmail: (request as AgentRequest).agentUser.email,
            owner: (request as AgentRequest).agentUser.id,
          }
        : {}),
    };
    response.setHeader('X-Request-Id', trace.requestId);
    // Docker health probes are intentionally excluded from the persistent journal.
    if (request.path === '/api/health' || request.path === '/health')
      return next.handle();
    const started = Date.now();
    let error: Record<string, unknown> | undefined;
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      response.off('finish', finish);
      response.off('close', finish);
      void this.audit.write(
        'http_completed',
        {
          status: response.writableFinished ? response.statusCode : 499,
          durationMs: Date.now() - started,
          cancelled: !response.writableFinished,
          ...(error ? { error } : {}),
        },
        trace,
      );
    };
    response.once('finish', finish);
    response.once('close', finish);
    void this.audit.write('http_started', {}, trace);
    return new Observable((subscriber) =>
      this.audit.run(trace, () =>
        next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (exception: unknown) => {
            const body =
              exception instanceof HttpException
                ? exception.getResponse()
                : undefined;
            const data =
              typeof body === 'object' && body !== null
                ? (body as Record<string, unknown>)
                : {};
            error = {};
            for (const field of ['code', 'provider', 'reason', 'suggestion'])
              if (typeof data[field] === 'string')
                error[field] = sanitizeErrorMessage(data[field]);
            if (typeof data.upstreamStatus === 'number')
              error.upstreamStatus = data.upstreamStatus;
            error.message = sanitizeErrorMessage(
              exception instanceof Error ? exception.message : 'Unknown error',
            );
            if (Array.isArray(data.message))
              error.validation = data.message
                .filter((item): item is string => typeof item === 'string')
                .map((item) => sanitizeErrorMessage(item));
            subscriber.error(exception);
          },
          complete: () => subscriber.complete(),
        }),
      ),
    );
  }
}
