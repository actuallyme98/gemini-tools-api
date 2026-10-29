import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentStore } from '../agent/agent.store';
import { AgentAssetsService } from '../agent/agent-assets.service';
import { publicAsset } from '../agent/agent.service';
import { adminAction } from '../agent/admin-audit';
import { AIService } from '../ai/ai.service';
import { ApiError } from '../common/api-error';
import type { AgentUser, Asset, AdminAudit } from '../agent/agent.types';
import type {
  IdeaInput,
  StudioIdea,
  StudioResource,
  StudioReview,
  StudioSlot,
  StudioSnapshot,
  StudioPlanStep,
  StudioOccurrence,
  StudioSchedule,
  StudioBatch,
  StudioStore,
  StudioTeam,
  StudioTicket,
} from './studio.types';
import { nextStudioNight, studioHash } from './studio.util';
import { assertStudioAssetAccess } from './studio-asset-access';
import type { StudioMockup } from './studio-mockup.types';

const conflict = () =>
  new ApiError(
    409,
    'STUDIO_REVISION_CONFLICT',
    'Nội dung đã thay đổi ở tab khác. Hãy tải lại trước khi tiếp tục.',
  );
const unavailable = () =>
  new ApiError(
    404,
    'STUDIO_NOT_FOUND',
    'Không tìm thấy dữ liệu hoặc bạn không còn quyền truy cập.',
  );

@Injectable()
export class StudioService {
  constructor(
    readonly store: AgentStore,
    readonly assets: AgentAssetsService,
    private readonly ai: AIService,
    private readonly config: ConfigService,
  ) {}

  async team(user: AgentUser, id: string, leader = false) {
    if (user.disabled) throw unavailable();
    const team = await this.store.find<StudioTeam>('studio-team', id);
    const role = team?.members.find(
      (member) => member.userId === user.id,
    )?.role;
    if (
      !team ||
      team.archived ||
      (user.role !== 'admin' && (!role || (leader && role !== 'leader')))
    )
      throw unavailable();
    return team;
  }
  async shop(user: AgentUser, id: string, leader = false) {
    const shop = await this.store.find<StudioStore>('studio-store', id);
    if (!shop || shop.archived) throw unavailable();
    const team = await this.team(user, shop.teamId, leader);
    const isLeader = team.members.some(
      (m) => m.userId === user.id && m.role === 'leader',
    );
    if (user.role !== 'admin' && !isLeader && !shop.sellerIds.includes(user.id))
      throw unavailable();
    return shop;
  }
  async idea(user: AgentUser, id: string, leader = false) {
    const idea = await this.store.find<StudioIdea>('studio-idea', id);
    if (!idea) throw unavailable();
    await this.shop(user, idea.input.storeId, leader);
    return idea;
  }
  async ticket(user: AgentUser, id: string) {
    const ticket = await this.store.find<StudioTicket>('studio-ticket', id);
    if (!ticket) throw unavailable();
    await this.shop(user, ticket.storeId);
    return ticket;
  }
  async bootstrap(user: AgentUser) {
    const schedule = await this.schedule();
    const teams = await this.store.query<StudioTeam>(
      'studio-team',
      {
        archived: false,
        ...(user.role === 'admin' ? {} : { memberIds: user.id }),
      },
      200,
      -1,
    );
    const teamIds = teams.map((team) => team.id);
    const candidates = teamIds.length
      ? await this.store.query<StudioStore>(
          'studio-store',
          { teamId: { $in: teamIds }, archived: false },
          1000,
          -1,
        )
      : [];
    const stores = candidates.filter(
      (shop) =>
        user.role === 'admin' ||
        shop.sellerIds.includes(user.id) ||
        teams.some(
          (team) =>
            team.id === shop.teamId &&
            team.members.some(
              (m) => m.userId === user.id && m.role === 'leader',
            ),
        ),
    );
    const resources = teamIds.length
      ? await this.store.query<StudioResource>(
          'studio-resource',
          {
            teamId: { $in: teamIds },
            ...(user.role === 'admin' ? {} : { status: 'approved' }),
          },
          1000,
          -1,
        )
      : [];
    const users =
      user.role === 'admin'
        ? (await this.store.query<AgentUser>('user', {}, 1000)).map(
            ({ id, email, disabled }) => ({ id, email, disabled: !!disabled }),
          )
        : [];
    return {
      teams,
      stores,
      resources,
      users,
      timezone: 'Asia/Ho_Chi_Minh',
      nextNight: schedule.nextRunAt,
      schedule,
    };
  }
  async schedule() {
    await this.store.ensure<StudioSchedule>('studio-schedule', {
      ...this.store.create<StudioSchedule>('studio-system', {
        dailyTime: '22:00',
        revision: 0,
      }),
      id: 'company',
    });
    const saved = await this.store.find<StudioSchedule>(
      'studio-schedule',
      'company',
    );
    return {
      dailyTime: saved.dailyTime,
      revision: saved.revision,
      timezone: 'Asia/Ho_Chi_Minh' as const,
      nextRunAt: nextStudioNight(new Date(), saved.dailyTime),
    };
  }
  async dashboard(user: AgentUser) {
    const storeIds = await this.store.studioVisibleStoreIds(user);
    return {
      ...(await this.store.studioDashboard(storeIds)),
      storeCount: storeIds.length,
      generatedAt: new Date().toISOString(),
    };
  }
  async catalog(
    user: AgentUser,
    input: {
      teamId: string;
      type?: StudioResource['type'];
      q?: string;
      status?: StudioResource['status'];
      storeId?: string;
      page: number;
    },
  ) {
    await this.team(user, input.teamId);
    const fields: Record<string, unknown> = {
      teamId: input.teamId,
      ...(input.type ? { type: input.type } : {}),
      ...(user.role === 'admin'
        ? input.status
          ? { status: input.status }
          : {}
        : { status: 'approved' }),
    };
    if (input.storeId) {
      const shop = await this.shop(user, input.storeId);
      if (shop.teamId !== input.teamId) throw unavailable();
      if (input.type === 'product') fields.id = { $in: shop.productIds };
    }
    if (input.q) {
      const text = {
        $regex: input.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        $options: 'i',
      };
      fields.$or = [{ name: text }, { code: text }];
    }
    return this.store.adminPage<StudioResource>(
      'studio-resource',
      fields,
      input.page,
      24,
    );
  }
  async catalogItem(user: AgentUser, id: string) {
    const resource = await this.store.find<StudioResource>(
      'studio-resource',
      id,
    );
    if (!resource) throw unavailable();
    await this.team(user, resource.teamId);
    if (resource.status !== 'approved' && user.role !== 'admin')
      throw unavailable();
    return resource;
  }
  async changeSchedule(
    user: AgentUser,
    input: { dailyTime: string; revision: number; reason: string },
  ) {
    return adminAction(
      this.store,
      user,
      'studio.schedule.changed',
      'company',
      input,
      async () => {
        const current = await this.schedule();
        const saved = await this.store.patch<StudioSchedule>(
          'studio-schedule',
          'company',
          'studio-system',
          {
            dailyTime: input.dailyTime,
            revision: current.revision + 1,
          },
          { revision: input.revision },
        );
        if (!saved) throw conflict();
        return this.schedule();
      },
    );
  }
  async saveTeam(
    user: AgentUser,
    id: string | undefined,
    input: Pick<StudioTeam, 'name' | 'members' | 'archived'> & {
      revision?: number;
    },
  ) {
    return adminAction(
      this.store,
      user,
      'studio.team.saved',
      id ?? 'new',
      { name: input.name },
      async () => {
        const members = [...new Set(input.members.map((m) => m.userId))];
        if (members.length !== input.members.length)
          throw new ApiError(
            400,
            'STUDIO_MEMBERS_INVALID',
            'Mỗi thành viên chỉ có một vai trò trong nhóm.',
          );
        for (const member of members) {
          const account = await this.store.find<AgentUser>('user', member);
          if (!account || account.disabled)
            throw new ApiError(
              400,
              'STUDIO_MEMBERS_INVALID',
              'Thành viên không tồn tại hoặc đã bị khóa.',
            );
        }
        const fields = {
          name: input.name,
          members: input.members,
          memberIds: members,
          archived: input.archived,
        };
        if (!id)
          return this.store.insert(
            'studio-team',
            this.store.create<StudioTeam>(user.id, { ...fields, revision: 1 }),
          );
        const current = await this.store.find<StudioTeam>('studio-team', id);
        if (!current) throw unavailable();
        return (
          (await this.store.patch<StudioTeam>(
            'studio-team',
            id,
            current.owner,
            { ...fields, revision: current.revision + 1 },
            { revision: input.revision },
          )) ?? Promise.reject(conflict())
        );
      },
    );
  }
  async saveStore(
    user: AgentUser,
    id: string | undefined,
    input: Pick<
      StudioStore,
      'teamId' | 'name' | 'sellerIds' | 'productIds' | 'archived'
    > & { revision?: number },
  ) {
    return adminAction(
      this.store,
      user,
      'studio.store.saved',
      id ?? 'new',
      { name: input.name },
      async () => {
        const team = await this.team(user, input.teamId);
        if (input.sellerIds.some((member) => !team.memberIds.includes(member)))
          throw new ApiError(
            400,
            'STUDIO_MEMBERS_INVALID',
            'Nhân sự cửa hàng phải thuộc nhóm.',
          );
        for (const id of input.productIds)
          await this.resource(user, id, input.teamId, 'product');
        if (!id)
          return this.store.insert(
            'studio-store',
            this.store.create<StudioStore>(user.id, { ...input, revision: 1 }),
          );
        const current = await this.store.find<StudioStore>('studio-store', id);
        if (!current || current.teamId !== input.teamId) throw unavailable();
        return (
          (await this.store.patch<StudioStore>(
            'studio-store',
            id,
            current.owner,
            { ...input, revision: current.revision + 1 },
            { revision: input.revision },
          )) ?? Promise.reject(conflict())
        );
      },
    );
  }
  async resource(
    user: AgentUser,
    id: string,
    teamId: string,
    type?: StudioResource['type'],
  ) {
    await this.team(user, teamId);
    const resource = await this.store.find<StudioResource>(
      'studio-resource',
      id,
    );
    if (
      !resource ||
      resource.teamId !== teamId ||
      resource.status !== 'approved' ||
      (type && resource.type !== type)
    )
      throw new ApiError(
        400,
        'STUDIO_RESOURCE_UNAVAILABLE',
        'Bộ hướng dẫn, sản phẩm hoặc ảnh mẫu chưa được duyệt hay không thuộc nhóm.',
      );
    return resource;
  }
  async saveResource(
    user: AgentUser,
    input: Pick<
      StudioResource,
      'teamId' | 'type' | 'name' | 'code' | 'instructions'
    > &
      Pick<StudioResource, 'assetId' | 'printSpec' | 'previousId'>,
  ) {
    return adminAction(
      this.store,
      user,
      'studio.resource.created',
      input.code,
      { type: input.type },
      async () => {
        await this.team(user, input.teamId);
        const previous = input.previousId
          ? await this.store.find<StudioResource>(
              'studio-resource',
              input.previousId,
            )
          : undefined;
        if (
          input.previousId &&
          (!previous ||
            previous.teamId !== input.teamId ||
            previous.type !== input.type ||
            input.type === 'skill')
        )
          throw new ApiError(
            400,
            'STUDIO_RESOURCE_VERSION_INVALID',
            'Bản trước phải cùng Team/loại nội dung. Bộ ZIP dùng chức năng nâng phiên bản riêng.',
          );
        if (previous?.assetId && !input.assetId) {
          const old = await this.assets.read(
            previous.owner,
            previous.assetId,
            user.id,
          );
          input = {
            ...input,
            assetId: (
              await this.assets.save(user.id, old.buffer, {
                name: old.asset.name,
                kind: 'template',
                category: input.code,
              })
            ).id,
          };
        }
        if (input.printSpec && input.type !== 'product')
          throw new ApiError(
            400,
            'STUDIO_PRINT_SPEC_INVALID',
            'Quy chuẩn in chỉ áp dụng cho sản phẩm.',
          );
        if (input.assetId)
          await this.store.get<Asset>('asset', input.assetId, user.id);
        if (['thumbnail', 'scene'].includes(input.type) && !input.assetId)
          throw new ApiError(
            400,
            'STUDIO_IMAGE_REQUIRED',
            'Mẫu ảnh cần có ảnh xem trước.',
          );
        return this.store.insert(
          'studio-resource',
          this.store.create<StudioResource>(user.id, {
            ...input,
            ...(previous
              ? {
                  seriesId: previous.seriesId ?? previous.id,
                  versionNumber: (previous.versionNumber ?? 1) + 1,
                }
              : {}),
            issues: [],
            status: input.type === 'skill' ? 'pending' : 'approved',
            revision: 1,
          }),
        );
      },
    );
  }
  async approveResource(
    user: AgentUser,
    id: string,
    revision: number,
    status: 'approved' | 'archived',
  ) {
    return adminAction(
      this.store,
      user,
      'studio.resource.reviewed',
      id,
      { status },
      async () => {
        const resource = await this.store.find<StudioResource>(
          'studio-resource',
          id,
        );
        if (!resource) throw unavailable();
        if (
          status === 'approved' &&
          (resource.issues.length ||
            (resource.importState && resource.importState !== 'ready'))
        )
          throw new ApiError(
            400,
            'STUDIO_SKILL_UNSUPPORTED',
            'Bộ hướng dẫn còn tài nguyên/công cụ chưa được hỗ trợ.',
          );
        return (
          (await this.store.patch<StudioResource>(
            'studio-resource',
            id,
            resource.owner,
            { status, revision: resource.revision + 1 },
            { revision },
          )) ?? Promise.reject(conflict())
        );
      },
    );
  }
  assertScheduleAccess(user: AgentUser, input: IdeaInput) {
    if (input.timing === 'night' && user.role !== 'admin')
      throw new ApiError(
        403,
        'STUDIO_SCHEDULE_ADMIN_ONLY',
        'Chỉ quản trị viên được sử dụng lịch chạy tự động.',
      );
  }
  async validateDraft(user: AgentUser, input: IdeaInput) {
    this.assertScheduleAccess(user, input);
    if (input.sampleCount !== undefined && input.sampleCount > input.count)
      throw new ApiError(
        400,
        'STUDIO_SAMPLE_COUNT_INVALID',
        'Số mẫu thử không được vượt tổng số thiết kế.',
      );
    const shop = await this.shop(user, input.storeId);
    if (input.productId && !shop.productIds.includes(input.productId))
      throw new ApiError(
        400,
        'STUDIO_PRODUCT_UNAVAILABLE',
        'Cửa hàng chưa được cấp sản phẩm này.',
      );
    for (const [id, type] of [
      [input.productId, 'product'],
      [input.skillId, 'skill'],
      [input.thumbnailId, 'thumbnail'],
    ] as const)
      if (id) await this.resource(user, id, shop.teamId, type);
    if (input.sourceId)
      await this.store.get<Asset>('asset', input.sourceId, user.id);
    return shop;
  }
  async validateInput(user: AgentUser, input: IdeaInput) {
    if (
      ![
        input.title,
        input.productId,
        input.skillId,
        input.thumbnailId,
        input.sourceId,
        input.brief,
        input.imageModel,
      ].every((value) => value.trim())
    )
      throw new ApiError(
        400,
        'STUDIO_INPUT_INCOMPLETE',
        'Điền đầy đủ ảnh ý tưởng, sản phẩm, bộ hướng dẫn, mẫu ảnh chính, yêu cầu và model trước khi gửi duyệt.',
      );
    const shop = await this.validateDraft(user, input);
    if (
      input.artworkFirst &&
      !(await this.resource(user, input.productId, shop.teamId, 'product'))
        .printSpec
    )
      throw new ApiError(
        400,
        'STUDIO_PRINT_SPEC_REQUIRED',
        'Sản phẩm cần quy chuẩn pixel/DPI trước khi tạo artwork. Nhờ quản trị thêm quy chuẩn hoặc chọn chỉ tạo ảnh sản phẩm.',
      );
    return shop;
  }
  async saveIdea(
    user: AgentUser,
    id: string | undefined,
    input: IdeaInput,
    revision?: number,
  ) {
    const shop = await this.validateDraft(user, input);
    if (!id)
      return this.store.insert(
        'studio-idea',
        this.store.create<StudioIdea>(user.id, {
          teamId: shop.teamId,
          input,
          revision: 1,
          state: 'draft',
          reviewNote: '',
        }),
      );
    const current = await this.idea(user, id);
    if (current.owner !== user.id || current.teamId !== shop.teamId)
      throw unavailable();
    // A saved edit creates a fresh draft; already dispatched tickets keep their immutable snapshot.
    return (
      (await this.store.patch<StudioIdea>(
        'studio-idea',
        id,
        current.owner,
        {
          input,
          revision: current.revision + 1,
          state: 'draft',
          reviewNote: '',
          approvedBy: '',
          ticketId: '',
          snapshot: undefined,
          dueAt: '',
        },
        { revision },
      )) ?? Promise.reject(conflict())
    );
  }
  async ideas(user: AgentUser, page = 1, state?: string) {
    const storeIds = await this.store.studioVisibleStoreIds(user);
    return this.store.adminPage<StudioIdea>(
      'studio-idea',
      {
        'input.storeId': { $in: storeIds },
        ...(state ? { state } : {}),
      },
      page,
      24,
    );
  }
  async submit(user: AgentUser, id: string, revision: number) {
    const idea = await this.idea(user, id);
    if (idea.owner !== user.id) throw unavailable();
    await this.validateInput(user, idea.input);
    return (
      (await this.store.patch<StudioIdea>(
        'studio-idea',
        id,
        idea.owner,
        { state: 'pending', revision: revision + 1, reviewNote: '' },
        { revision, state: { $in: ['draft', 'changes_requested'] } },
      )) ?? Promise.reject(conflict())
    );
  }
  async decide(
    user: AgentUser,
    id: string,
    revision: number,
    decision: 'approved' | 'changes_requested',
    note: string,
  ) {
    const idea = await this.idea(user, id, true);
    if (decision === 'approved') this.assertScheduleAccess(user, idea.input);
    if (
      decision === 'approved' &&
      idea.input.timing === 'night' &&
      !this.config.get<boolean>('STUDIO_SCHEDULER_ENABLED', false)
    )
      throw new ApiError(
        409,
        'STUDIO_SCHEDULE_DISABLED',
        'Lịch chạy đêm chưa được bật. Chọn chạy sau khi duyệt hoặc chờ quản trị bật lịch.',
      );
    if (decision === 'changes_requested') {
      if (!note.trim())
        throw new ApiError(
          400,
          'STUDIO_REASON_REQUIRED',
          'Hãy ghi nội dung cần bổ sung.',
        );
      return (
        (await this.store.patch<StudioIdea>(
          'studio-idea',
          id,
          idea.owner,
          { state: decision, reviewNote: note, revision: revision + 1 },
          { revision, state: 'pending' },
        )) ?? Promise.reject(conflict())
      );
    }
    const owner = await this.store.find<AgentUser>('user', idea.owner);
    if (!owner || owner.disabled) throw unavailable();
    await this.validateInput(owner, idea.input);
    await this.ai.validateImageModel(
      idea.input.provider,
      idea.input.imageModel,
    );
    const [product, skill, thumbnail] = await Promise.all([
      this.resource(user, idea.input.productId, idea.teamId, 'product'),
      this.resource(user, idea.input.skillId, idea.teamId, 'skill'),
      this.resource(user, idea.input.thumbnailId, idea.teamId, 'thumbnail'),
    ]);
    const source = await this.store.get<Asset>(
      'asset',
      idea.input.sourceId,
      idea.owner,
    );
    const master = await this.store.get<Asset>(
      'asset',
      thumbnail.assetId,
      thumbnail.owner,
    );
    if (source.id === master.id)
      throw new ApiError(
        400,
        'STUDIO_IMAGE_ROLE',
        'Ảnh ý tưởng và mẫu ảnh chính phải khác nhau.',
      );
    const snapshot: StudioSnapshot = {
      input: idea.input,
      product: {
        id: product.id,
        code: product.code,
        name: product.name,
        instructions: product.instructions,
        ...(product.printSpec ? { printSpec: product.printSpec } : {}),
      },
      skill: {
        id: skill.id,
        code: skill.code,
        name: skill.name,
        instructions: skill.instructions,
        documents: skill.documents,
        bundleHash: skill.bundleHash,
        versionNumber: skill.versionNumber,
        declaredVersion: skill.declaredVersion,
      },
      thumbnail: {
        id: thumbnail.id,
        code: thumbnail.code,
        name: thumbnail.name,
        instructions: thumbnail.instructions,
      },
      source: { id: source.id, owner: source.owner, sha256: source.sha256 },
      master: { id: master.id, owner: master.owner, sha256: master.sha256 },
      hash: '',
      planningVersion: 1,
      contextImages: (skill.contextImages ?? []).filter((image) =>
        skill.selectedContextPaths?.includes(image.path),
      ),
    };
    if (skill.activeDocumentPaths)
      snapshot.skill.documents = skill.documents?.filter((document) =>
        skill.activeDocumentPaths.includes(document.path),
      );
    for (const ref of snapshot.contextImages ?? []) {
      const asset = await this.store.get<Asset>('asset', ref.id, ref.owner);
      if (asset.sha256 !== ref.sha256)
        throw new ApiError(
          409,
          'STUDIO_IMAGE_CHANGED',
          'Ảnh ví dụ không khớp phiên bản đã duyệt.',
        );
    }
    snapshot.hash = studioHash(JSON.stringify(snapshot));
    const ticketId = `${idea.id}-r${revision + 1}`;
    const dueAt =
      idea.input.timing === 'night'
        ? nextStudioNight(new Date(), (await this.schedule()).dailyTime)
        : new Date().toISOString();
    const saved = await this.store.patch<StudioIdea>(
      'studio-idea',
      id,
      idea.owner,
      {
        state: 'approved',
        approvedBy: user.id,
        revision: revision + 1,
        ticketId,
        snapshot,
        dueAt,
      },
      { revision, state: 'pending' },
    );
    if (!saved) throw conflict();
    // Durable approval is the outbox: a restart between this write and ticket creation can be reconciled.
    await this.ensureTicket(saved);
    await this.log(user, 'studio.idea.approved', id, {
      ticketId,
      snapshotHash: snapshot.hash,
    });
    return saved;
  }
  async ensureTicket(idea: StudioIdea) {
    if (!idea.ticketId || !idea.snapshot || !idea.dueAt) return;
    let occurrenceId: string | undefined, batchId: string | undefined;
    if (idea.input.timing === 'night') {
      const day = new Date(Date.parse(idea.dueAt) + 7 * 3600000)
        .toISOString()
        .slice(0, 10);
      const occurrence = this.store.create<StudioOccurrence>('studio-system', {
        day,
        dueAt: idea.dueAt,
        cutoffAt: idea.dueAt,
        windowEndsAt: new Date(
          Date.parse(idea.dueAt) + 5 * 60000,
        ).toISOString(),
        timezone: 'Asia/Ho_Chi_Minh',
      });
      const time = new Date(Date.parse(idea.dueAt) + 7 * 3600000)
        .toISOString()
        .slice(11, 16);
      // Keep existing 22:00 occurrence IDs; changed times on the same day need separate immutable cutoffs.
      occurrence.id = `night-${day}${time === '22:00' ? '' : '-' + time.replace(':', '')}`;
      occurrenceId = occurrence.id;
      await this.store.ensure('studio-occurrence', occurrence);
      const batch = this.store.create<StudioBatch>('studio-system', {
        occurrenceId,
        teamId: idea.teamId,
        day,
        dueAt: idea.dueAt,
      });
      batch.id = `${occurrenceId}-${idea.teamId}`;
      batchId = batch.id;
      await this.store.ensure('studio-batch', batch);
    }
    const ticket = this.store.create<StudioTicket>(idea.owner, {
      teamId: idea.teamId,
      storeId: idea.input.storeId,
      ideaId: idea.id,
      ideaRevision: idea.revision,
      approvedBy: idea.approvedBy,
      snapshot: idea.snapshot,
      ...(occurrenceId ? { occurrenceId, batchId } : {}),
      dueAt: idea.dueAt,
      state: idea.input.timing === 'night' ? 'scheduled' : 'queued',
      dispatchCount:
        idea.input.timing === 'night'
          ? idea.input.count
          : (idea.input.sampleCount ?? idea.input.count),
    });
    ticket.id = idea.ticketId;
    await this.store.ensure('studio-ticket', ticket);
  }
  async detail(user: AgentUser, id: string) {
    const idea = await this.idea(user, id);
    const visibleStoreIds = await this.store.studioVisibleStoreIds(user);
    const tickets = await this.store.query<StudioTicket>(
      'studio-ticket',
      { ideaId: id, storeId: { $in: visibleStoreIds } },
      100,
      -1,
    );
    const slots = tickets.length
      ? await this.store.query<StudioSlot>(
          'studio-slot',
          { ticketId: { $in: tickets.map((ticket) => ticket.id) } },
          1000,
        )
      : [];
    const reviews = tickets.length
      ? await this.store.query<StudioReview>(
          'studio-review',
          { ticketId: { $in: tickets.map((ticket) => ticket.id) } },
          1000,
        )
      : [];
    const assets = await this.store.query<Asset>(
      'asset',
      {
        id: {
          $in: slots.flatMap((slot) => (slot.resultId ? [slot.resultId] : [])),
        },
      },
      1000,
    );
    const plans = tickets.length
      ? await this.store.query<StudioPlanStep>(
          'studio-plan',
          { ticketId: { $in: tickets.map((ticket) => ticket.id) } },
          200,
        )
      : [];
    return {
      idea,
      tickets,
      slots: slots.filter((s) => s.role !== 'artwork'),
      artworks: slots.filter((s) => s.role === 'artwork'),
      reviews,
      assets: assets.map(publicAsset),
      plans,
    };
  }
  async imageAccess(user: AgentUser, id: string) {
    const asset = await this.store.find<Asset>('asset', id);
    if (!asset) throw unavailable();
    await assertStudioAssetAccess(this.store, asset, user.id);
    if (asset.studioMockupId) return asset;
    if (asset.owner === user.id) return asset;
    const resource = (
      await this.store.query<StudioResource>(
        'studio-resource',
        { assetId: id },
        1,
      )
    )[0];
    if (resource && (resource.status === 'approved' || user.role === 'admin')) {
      await this.team(user, resource.teamId);
      return asset;
    }
    for (const skill of await this.store.query<StudioResource>(
      'studio-resource',
      {
        'contextImages.id': id,
        ...(user.role === 'admin' ? {} : { status: 'approved' }),
      },
      20,
    )) {
      try {
        await this.team(user, skill.teamId);
        return asset;
      } catch {
        /* Try another explicit grant. */
      }
    }
    for (const idea of await this.store.query<StudioIdea>(
      'studio-idea',
      { 'input.sourceId': id },
      20,
    )) {
      try {
        await this.shop(user, idea.input.storeId);
        return asset;
      } catch {
        /* Try another explicit grant. */
      }
    }
    for (const job of await this.store.query<StudioMockup>(
      'studio-mockup',
      { 'sources.image.id': id },
      20,
    )) {
      try {
        await this.shop(user, job.storeId);
        return asset;
      } catch {
        /* Try another explicit grant. */
      }
    }
    for (const job of await this.store.query<StudioMockup>(
      'studio-mockup',
      { 'scenes.image.id': id },
      20,
    )) {
      try {
        await this.shop(user, job.storeId);
        return asset;
      } catch {
        /* Try another explicit grant. */
      }
    }
    const slot = (
      await this.store.query<StudioSlot>('studio-slot', { resultId: id }, 1)
    )[0];
    if (slot) {
      await this.ticket(user, slot.ticketId);
      return asset;
    }
    throw unavailable();
  }
  async reviewOutput(
    user: AgentUser,
    ticketId: string,
    assetId: string,
    decision: StudioReview['decision'],
    note: string,
  ) {
    const ticket = await this.ticket(user, ticketId);
    const slot = (
      await this.store.query<StudioSlot>(
        'studio-slot',
        { ticketId, resultId: assetId, state: 'done' },
        1,
      )
    )[0];
    if (!slot) throw unavailable();
    if (slot.role === 'artwork' && decision === 'approved') {
      const asset = await this.store.find<Asset>('asset', assetId);
      if (!asset?.checks?.technical)
        throw new ApiError(
          409,
          'STUDIO_ARTWORK_NOT_READY',
          'Artwork chưa đạt quy chuẩn file (kích thước/nền). Cần sửa file trước khi duyệt.',
        );
    }
    const id = `${ticketId}-${assetId}`;
    const previous = await this.store.find<StudioReview>('studio-review', id);
    if (previous) {
      const updated = await this.store.patch<StudioReview>(
        'studio-review',
        id,
        previous.owner,
        { decision, note, revision: previous.revision + 1 },
        { revision: previous.revision },
      );
      if (!updated) throw conflict();
      await this.log(user, 'studio.output.reviewed', assetId, {
        ticketId,
        decision,
        note,
        revision: updated.revision,
      });
      return updated;
    }
    const review = this.store.create<StudioReview>(user.id, {
      teamId: ticket.teamId,
      ticketId,
      assetId,
      decision,
      note,
      revision: 1,
    });
    review.id = id;
    await this.store.ensure('studio-review', review);
    await this.log(user, 'studio.output.reviewed', assetId, {
      ticketId,
      decision,
      note,
      revision: 1,
    });
    return this.store.find<StudioReview>('studio-review', id);
  }
  async cancel(user: AgentUser, id: string) {
    const ticket = await this.ticket(user, id);
    if (ticket.owner !== user.id) await this.team(user, ticket.teamId, true);
    return (
      (await this.store.patch<StudioTicket>(
        'studio-ticket',
        id,
        ticket.owner,
        { state: 'cancelled' },
        {
          state: {
            $in: [
              'scheduled',
              'queued',
              'running',
              'missed',
              'blocked',
              'sample_review',
            ],
          },
        },
      )) ?? Promise.reject(conflict())
    );
  }
  async continueSamples(user: AgentUser, id: string) {
    const ticket = await this.ticket(user, id);
    if (ticket.owner !== user.id) await this.team(user, ticket.teamId, true);
    const owner = await this.store.find<AgentUser>('user', ticket.owner);
    const approver = await this.store.find<AgentUser>(
      'user',
      ticket.approvedBy,
    );
    if (!owner || owner.disabled || !approver || approver.disabled)
      throw unavailable();
    await this.shop(owner, ticket.storeId);
    await this.shop(approver, ticket.storeId, true);
    const saved = await this.store.patch<StudioTicket>(
      'studio-ticket',
      id,
      ticket.owner,
      { state: 'queued', dispatchCount: ticket.snapshot.input.count },
      { state: 'sample_review', dispatchCount: ticket.dispatchCount },
    );
    if (!saved)
      throw new ApiError(
        409,
        'STUDIO_STATE_CHANGED',
        'Lượt chạy đã được tiếp tục hoặc chưa đủ điều kiện. Tải lại trạng thái.',
      );
    await this.log(user, 'studio.ticket.continued', id, {
      remainingCount:
        ticket.snapshot.input.count -
        (ticket.dispatchCount ?? ticket.snapshot.input.count),
    });
    return saved;
  }
  async log(
    user: AgentUser,
    action: string,
    target: string,
    details: Record<string, unknown>,
  ) {
    await this.store.insert(
      'admin-audit',
      this.store.create<AdminAudit>(user.id, {
        actorEmail: user.email,
        action,
        target,
        details,
        outcome: 'success',
      }),
    );
  }
  async outputs(user: AgentUser, page = 1) {
    return this.store.studioOutputs(
      await this.store.studioVisibleStoreIds(user),
      page,
    );
  }
}
