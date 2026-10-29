import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { StudioService } from './studio.service';
import { AIService } from '../ai/ai.service';
import { ApiError } from '../common/api-error';
import type { AgentUser, Asset } from '../agent/agent.types';
import type { StudioAssetRef, StudioReview, StudioSlot } from './studio.types';
import type {
  MockupInput,
  StudioMockup,
  StudioMockupSlot,
} from './studio-mockup.types';
import { studioHash } from './studio.util';

export const SAFE_STUDIO_RETRY = [
  'TEAM_BUDGET_EXCEEDED',
  'USER_BUDGET_EXCEEDED',
  'BUDGET_PRICING_UNAVAILABLE',
  'TEAM_BUDGET_ACCESS_REVOKED',
  'STUDIO_ACCESS_REVOKED',
];
const missing = () =>
  new ApiError(
    404,
    'STUDIO_NOT_FOUND',
    'Không tìm thấy bộ mockup hoặc bạn không còn quyền truy cập.',
  );
@Injectable()
export class StudioMockupService {
  constructor(
    readonly studio: StudioService,
    private readonly ai: AIService,
  ) {}
  async job(user: AgentUser, id: string) {
    const job = await this.studio.store.find<StudioMockup>('studio-mockup', id);
    if (!job) throw missing();
    await this.studio.shop(user, job.storeId);
    return job;
  }
  async list(user: AgentUser, page: number) {
    const storeIds = await this.studio.store.studioVisibleStoreIds(user);
    return this.studio.store.adminPage<StudioMockup>(
      'studio-mockup',
      { storeId: { $in: storeIds } },
      page,
      20,
    );
  }
  async detail(user: AgentUser, id: string) {
    const job = await this.job(user, id);
    const [slots, reviews] = await Promise.all([
      this.studio.store.query<StudioMockupSlot>(
        'studio-mockup-slot',
        { jobId: id },
        100,
      ),
      this.studio.store.query<StudioReview>(
        'studio-review',
        { ticketId: id },
        100,
      ),
    ]);
    return { job, slots: slots.sort((a, b) => a.index - b.index), reviews };
  }
  private ref(asset: Asset): StudioAssetRef {
    return { id: asset.id, owner: asset.owner, sha256: asset.sha256 };
  }
  async create(user: AgentUser, input: MockupInput) {
    const shop = await this.studio.shop(user, input.storeId);
    if (!shop.productIds.includes(input.productId)) throw missing();
    const product = await this.studio.resource(
      user,
      input.productId,
      shop.teamId,
      'product',
    );
    const id = 'mockup-' + studioHash(`${user.id}:${input.requestKey}`);
    const inputHash = studioHash(JSON.stringify(input));
    const previous = await this.studio.store.find<StudioMockup>(
      'studio-mockup',
      id,
    );
    if (previous) {
      if (previous.inputHash !== inputHash)
        throw new ApiError(
          409,
          'STUDIO_REQUEST_CHANGED',
          'Yêu cầu này đã được lưu với đầu vào khác. Hãy tạo bộ mới.',
        );
      return previous;
    }
    await this.ai.validateImageModel(input.provider, input.imageModel);
    const sources: StudioMockup['sources'] = [];
    for (const source of input.sources) {
      const asset = await this.studio.imageAccess(user, source.assetId);
      if (source.ticketId || asset.studioTicketId) {
        if (!source.ticketId)
          throw new ApiError(
            400,
            'STUDIO_REVIEW_REQUIRED',
            'Ảnh Gallery cần có lượt chạy nguồn và đã được duyệt.',
          );
        const ticket = await this.studio.ticket(user, source.ticketId);
        const review = await this.studio.store.find<StudioReview>(
          'studio-review',
          `${ticket.id}-${asset.id}`,
        );
        const slot = (
          await this.studio.store.query<StudioSlot>(
            'studio-slot',
            { ticketId: ticket.id, resultId: asset.id, state: 'done' },
            1,
          )
        )[0];
        if (
          !slot ||
          ticket.storeId !== shop.id ||
          ticket.snapshot.product.id !== product.id ||
          review?.decision !== 'approved'
        )
          throw missing();
      } else if (asset.owner !== user.id || asset.studioMockupId)
        throw missing();
      sources.push({
        image: this.ref(asset),
        ticketId: source.ticketId,
        sceneIds: source.sceneIds,
        colors: source.colors,
      });
    }
    const scenes: StudioMockup['scenes'] = [];
    for (const sceneId of new Set(input.sources.flatMap((s) => s.sceneIds))) {
      const resource = await this.studio.resource(
        user,
        sceneId,
        shop.teamId,
        'scene',
      );
      const asset = await this.studio.store.get<Asset>(
        'asset',
        resource.assetId,
        resource.owner,
      );
      scenes.push({
        id: resource.id,
        name: resource.name,
        instructions: resource.instructions,
        image: this.ref(asset),
      });
    }
    if (
      sources.some((s) =>
        s.sceneIds.some(
          (sceneId) =>
            scenes.find((scene) => scene.id === sceneId)?.image.id ===
            s.image.id,
        ),
      )
    )
      throw new ApiError(
        400,
        'STUDIO_INPUTS_IDENTICAL',
        'Ảnh nguồn và bối cảnh phải là hai ảnh khác nhau.',
      );
    const count = sources.reduce(
      (sum, s) => sum + s.sceneIds.length * s.colors.length,
      0,
    );
    if (count > 100)
      throw new ApiError(
        400,
        'STUDIO_TOO_MANY_COMBINATIONS',
        'Mỗi bộ tối đa 100 ảnh. Hãy giảm nguồn, bối cảnh hoặc màu.',
      );
    const job = this.studio.store.create<StudioMockup>(user.id, {
      teamId: shop.teamId,
      storeId: shop.id,
      title: input.title,
      inputHash,
      product: { id: product.id, code: product.code, name: product.name },
      sources,
      scenes,
      provider: input.provider,
      imageModel: input.imageModel,
      instructions: input.instructions,
      count,
      state: 'queued',
    });
    job.id = id;
    await this.studio.store.ensure('studio-mockup', job);
    const saved = await this.job(user, id);
    if (saved.inputHash !== inputHash)
      throw new ApiError(
        409,
        'STUDIO_REQUEST_CHANGED',
        'Một tab khác đã gửi đầu vào khác với cùng mã yêu cầu.',
      );
    await this.studio.log(user, 'studio.mockup.created', id, { count });
    return saved;
  }
  async ensureSlots(job: StudioMockup) {
    let index = 0;
    for (const [sourceIndex, source] of job.sources.entries())
      for (const sceneId of source.sceneIds)
        for (const color of source.colors) {
          const scene = job.scenes.find((s) => s.id === sceneId);
          const slot = this.studio.store.create<StudioMockupSlot>(job.owner, {
            jobId: job.id,
            teamId: job.teamId,
            index,
            sourceIndex,
            sceneId,
            color,
            state: 'queued',
            requestId: randomUUID(),
            prompt: [
              'Tạo một ảnh mockup sản phẩm. ẢNH 1 là sản phẩm/thiết kế NGUỒN. ẢNH 2 là BỐI CẢNH ĐÍCH cần chỉnh sửa.',
              'Giữ bố cục, người mẫu, tư thế, ánh sáng, background và số lượng sản phẩm của ẢNH 2. Thay sản phẩm/thiết kế tương ứng trong ẢNH 2 bằng sản phẩm/thiết kế từ ẢNH 1; áp dụng lên tất cả vị trí tương ứng.',
              'Giữ nguyên chữ, hình in, màu thiết kế, kích thước tương đối và tỉ lệ của nguồn. Chỉ căn phối cảnh và ánh sáng cho phù hợp bề mặt đích. Không đảo vai trò hai ảnh, không ghép sản phẩm đích lên ảnh nguồn.',
              color
                ? `Màu nền vật liệu sản phẩm đích: ${color}. Chỉ đổi phần vật liệu; không đổi màu chữ hoặc hình thiết kế.`
                : 'Giữ màu vật liệu gốc, không tự đổi màu.',
              `Bối cảnh: ${scene.name}\n${scene.instructions}`,
              `Yêu cầu bổ sung: ${job.instructions}`,
              'Không tạo watermark, chữ ký, logo công cụ hoặc chữ quảng cáo mới. Chỉ trả về ảnh đã chỉnh sửa.',
            ].join('\n\n'),
          });
          slot.id = `${job.id}-image-${index++}`;
          await this.studio.store.ensure('studio-mockup-slot', slot);
        }
  }
  async checkPermission(job: StudioMockup) {
    const user = await this.studio.store.find<AgentUser>('user', job.owner);
    if (!user || user.disabled) throw missing();
    const shop = await this.studio.shop(user, job.storeId);
    if (!shop.productIds.includes(job.product.id)) throw missing();
    await this.studio.resource(user, job.product.id, job.teamId, 'product');
    for (const scene of job.scenes)
      await this.studio.resource(user, scene.id, job.teamId, 'scene');
    for (const source of job.sources) {
      if (source.ticketId) {
        const ticket = await this.studio.ticket(user, source.ticketId);
        const review = await this.studio.store.find<StudioReview>(
          'studio-review',
          `${ticket.id}-${source.image.id}`,
        );
        if (ticket.storeId !== shop.id || review?.decision !== 'approved')
          throw missing();
      }
    }
  }
  async change(user: AgentUser, id: string, action: 'cancel' | 'continue') {
    const { job, slots } = await this.detail(user, id);
    if (job.owner !== user.id) await this.studio.team(user, job.teamId, true);
    if (action === 'cancel') {
      const saved = await this.studio.store.patch<StudioMockup>(
        'studio-mockup',
        id,
        job.owner,
        { state: 'cancelled' },
        {
          state: {
            $in: ['queued', 'running', 'blocked', 'failed', 'partial_failed'],
          },
        },
      );
      if (!saved)
        throw new ApiError(
          409,
          'STUDIO_STATE_CHANGED',
          'Bộ ảnh đã đổi trạng thái. Hãy tải lại.',
        );
      await this.studio.log(user, 'studio.mockup.cancelled', id, {});
      return saved;
    }
    if (
      !['blocked', 'failed', 'partial_failed'].includes(job.state) ||
      slots.some((s) =>
        ['preparing', 'submitted', 'interrupted'].includes(s.state),
      )
    )
      throw new ApiError(
        409,
        'STUDIO_RECONCILIATION_REQUIRED',
        'Còn request đang chạy hoặc chưa rõ kết quả. Không thể gửi lại.',
      );
    await this.checkPermission(job);
    // Only known pre-provider failures are safe to resume.
    const reset = slots.filter(
      (s) =>
        s.state === 'failed' && SAFE_STUDIO_RETRY.includes(s.errorCode ?? ''),
    );
    if (
      !reset.length &&
      job.state !== 'blocked' &&
      !slots.some((s) => s.state === 'queued')
    )
      throw new ApiError(
        409,
        'STUDIO_RECONCILIATION_REQUIRED',
        'Không có tổ hợp được xác định an toàn để chạy tiếp.',
      );
    for (const slot of reset)
      await this.studio.store.patch<StudioMockupSlot>(
        'studio-mockup-slot',
        slot.id,
        job.owner,
        { state: 'queued', requestId: randomUUID(), error: '', errorCode: '' },
        { state: slot.state, requestId: slot.requestId },
      );
    const saved = await this.studio.store.patch<StudioMockup>(
      'studio-mockup',
      id,
      job.owner,
      { state: 'queued', error: '' },
      { state: job.state },
    );
    if (!saved)
      throw new ApiError(
        409,
        'STUDIO_STATE_CHANGED',
        'Một người khác đã tiếp tục bộ ảnh. Hãy tải lại.',
      );
    await this.studio.log(user, 'studio.mockup.continued', id, {
      count: reset.length,
    });
    return saved;
  }
  async review(
    user: AgentUser,
    id: string,
    assetId: string,
    decision: StudioReview['decision'],
    note: string,
  ) {
    const { job, slots } = await this.detail(user, id);
    if (!slots.some((s) => s.resultId === assetId && s.state === 'done'))
      throw missing();
    const reviewId = `${id}-${assetId}`;
    const old = await this.studio.store.find<StudioReview>(
      'studio-review',
      reviewId,
    );
    if (old) {
      const result = await this.studio.store.patch<StudioReview>(
        'studio-review',
        reviewId,
        old.owner,
        { decision, note, revision: old.revision + 1 },
        { revision: old.revision },
      );
      if (!result)
        throw new ApiError(
          409,
          'STUDIO_STATE_CHANGED',
          'Kết quả đã được duyệt ở tab khác.',
        );
      await this.studio.log(user, 'studio.mockup.reviewed', assetId, {
        jobId: id,
        decision,
        note,
        revision: result.revision,
      });
      return result;
    }
    const review = this.studio.store.create<StudioReview>(user.id, {
      teamId: job.teamId,
      ticketId: id,
      assetId,
      decision,
      note,
      revision: 1,
    });
    review.id = reviewId;
    await this.studio.store.ensure('studio-review', review);
    await this.studio.log(user, 'studio.mockup.reviewed', assetId, {
      jobId: id,
      decision,
      note,
      revision: 1,
    });
    return this.studio.store.find<StudioReview>('studio-review', reviewId);
  }
}
