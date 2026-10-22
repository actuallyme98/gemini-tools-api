import { ArgumentsHost, Catch, Optional } from '@nestjs/common';
import { MongoError } from 'mongodb';
import { ApiExceptionFilter } from '../common/api-exception.filter';
import { ApiError } from '../common/api-error';
import { AuditLogService } from '../audit/audit-log.service';

@Catch(MongoError)
export class AgentDatabaseFilter extends ApiExceptionFilter {
  constructor(@Optional() audit?: AuditLogService) {
    super(audit);
  }
  catch(error: MongoError, host: ArgumentsHost) {
    super.catch(
      new ApiError(
        503,
        'AGENT_DATABASE_UNAVAILABLE',
        'Không truy cập được dữ liệu Agent. Vui lòng thử tải lại sau; không tự gửi lại yêu cầu tạo ảnh.',
        { retryable: true, cause: error },
      ),
      host,
    );
  }
}
