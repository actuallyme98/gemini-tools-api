import { Injectable } from '@nestjs/common';
import { adminAction } from '../agent/admin-audit';
import type { AgentUser, Asset } from '../agent/agent.types';
import { ApiError } from '../common/api-error';
import { readSkillBundle } from './skill-bundle';
import { StudioService } from './studio.service';
import { StudioBundleService } from './studio-bundle.service';
import type { StudioResource } from './studio.types';
import { studioHash } from './studio.util';

@Injectable()
export class StudioLibraryService {
  constructor(
    private readonly studio: StudioService,
    private readonly bundles: StudioBundleService,
  ) {}
  async import(
    user: AgentUser,
    input: { teamId: string; name: string; code: string; previousId?: string },
    buffer: Buffer,
  ) {
    return adminAction(
      this.studio.store,
      user,
      'studio.skill.imported',
      input.code,
      { name: input.name, previousId: input.previousId },
      async () => {
        await this.studio.team(user, input.teamId);
        const bundle = await readSkillBundle(buffer);
        const previous = input.previousId
          ? await this.studio.store.find<StudioResource>(
              'studio-resource',
              input.previousId,
            )
          : undefined;
        if (
          input.previousId &&
          (!previous ||
            previous.teamId !== input.teamId ||
            previous.type !== 'skill' ||
            previous.code.toUpperCase() !== input.code.toUpperCase())
        )
          throw new ApiError(
            400,
            'STUDIO_SKILL_VERSION_INVALID',
            'Phiên bản trước phải thuộc cùng nhóm và mã bộ hướng dẫn.',
          );
        const seriesId =
          previous?.seriesId ??
          (previous
            ? previous.id
            : studioHash(`${input.teamId}:skill:${input.code.toUpperCase()}`));
        const versionNumber = previous ? (previous.versionNumber ?? 1) + 1 : 1;
        const resource = this.studio.store.create<StudioResource>(user.id, {
          teamId: input.teamId,
          name: input.name,
          code: input.code,
          previousId: previous?.id,
          seriesId,
          versionNumber,
          declaredVersion: bundle.declaredVersion,
          importState: 'preparing',
          type: 'skill',
          instructions: bundle.instructions,
          documents: bundle.documents,
          files: bundle.files,
          bundleHash: bundle.bundleHash,
          activeDocumentPaths: bundle.activeDocumentPaths,
          warnings: bundle.warnings,
          issues: [...bundle.issues, 'Đang lưu ZIP và tài nguyên.'],
          status: 'pending',
          revision: 1,
        });
        try {
          await this.studio.store.insert('studio-resource', resource);
        } catch (error: unknown) {
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 11000
          )
            throw new ApiError(
              409,
              'STUDIO_SKILL_VERSION_EXISTS',
              'Đã có phiên bản kế tiếp. Tải lại thư viện và chọn phiên bản mới nhất để nâng cấp.',
            );
          throw error;
        }
        try {
          const archive = await this.bundles.save(
            user.id,
            input.teamId,
            buffer,
          );
          const contextImages: NonNullable<StudioResource['contextImages']> =
            [];
          const masters: StudioResource[] = [];
          for (const image of bundle.images) {
            const asset = await this.studio.assets.save(user.id, image.buffer, {
              name: image.path.split('/').at(-1),
              kind: 'template',
              category: input.code,
            });
            contextImages.push({
              id: asset.id,
              owner: asset.owner,
              sha256: asset.sha256,
              path: image.path,
            });
            if (!/\/assets\//.test('/' + image.path)) continue;
            masters.push(
              await this.studio.store.insert(
                'studio-resource',
                this.studio.store.create<StudioResource>(user.id, {
                  teamId: input.teamId,
                  type: 'thumbnail',
                  name: asset.name,
                  code: asset.name.replace(/\.[^.]+$/, ''),
                  instructions: `Dùng cùng ${input.code} phiên bản ${versionNumber}. Giữ quy tắc hình học/sản phẩm trong hướng dẫn; bối cảnh có thể thay đổi theo yêu cầu.`,
                  assetId: asset.id,
                  issues: [],
                  status: 'pending',
                  revision: 1,
                }),
              ),
            );
          }
          const saved = await this.studio.store.patch<StudioResource>(
            'studio-resource',
            resource.id,
            resource.owner,
            {
              importState: 'ready',
              bundleId: archive.id,
              issues: bundle.issues,
              contextImages,
              selectedContextPaths: [],
            },
            { importState: 'preparing' },
          );
          return { resource: saved, masters };
        } catch (error) {
          await this.studio.store.patch<StudioResource>(
            'studio-resource',
            resource.id,
            resource.owner,
            {
              importState: 'failed',
              issues: [
                'Không lưu đủ tài nguyên. Tải lại ZIP thành phiên bản mới trước khi duyệt.',
              ],
            },
            { importState: 'preparing' },
          );
          throw error;
        }
      },
    );
  }
  async versions(user: AgentUser, id: string) {
    const resource = await this.studio.store.find<StudioResource>(
      'studio-resource',
      id,
    );
    if (!resource || (user.role !== 'admin' && resource.status !== 'approved'))
      throw new ApiError(
        404,
        'STUDIO_NOT_FOUND',
        'Không tìm thấy bộ hướng dẫn.',
      );
    await this.studio.team(user, resource.teamId);
    if (resource.type !== 'skill')
      return this.studio.store.query<StudioResource>(
        'studio-resource',
        {
          teamId: resource.teamId,
          type: resource.type,
          $or: [
            { id: resource.seriesId ?? resource.id },
            { seriesId: resource.seriesId ?? resource.id },
          ],
          ...(user.role === 'admin' ? {} : { status: 'approved' }),
        },
        100,
        -1,
      );
    return resource.seriesId
      ? this.studio.store.query<StudioResource>(
          'studio-resource',
          {
            seriesId: resource.seriesId,
            ...(user.role === 'admin' ? {} : { status: 'approved' }),
          },
          100,
          -1,
        )
      : [resource];
  }
  async download(user: AgentUser, id: string) {
    if (user.role !== 'admin')
      throw new ApiError(
        403,
        'AGENT_ADMIN_REQUIRED',
        'Chỉ quản trị viên được tải ZIP gốc.',
      );
    const resource = await this.studio.store.find<StudioResource>(
      'studio-resource',
      id,
    );
    if (!resource?.bundleId || resource.importState !== 'ready')
      throw new ApiError(
        404,
        'STUDIO_BUNDLE_NOT_FOUND',
        'Phiên bản chưa có ZIP gốc đã lưu hoàn chỉnh.',
      );
    await this.studio.team(user, resource.teamId);
    const buffer = await this.bundles.read(resource.bundleId);
    if (studioHash(buffer) !== resource.bundleHash)
      throw new ApiError(
        503,
        'STUDIO_BUNDLE_CORRUPTED',
        'ZIP không khớp phiên bản đã lưu.',
      );
    await this.studio.log(user, 'studio.skill.downloaded', id, {
      bundleHash: resource.bundleHash,
    });
    return {
      buffer,
      name: `${resource.code}_v${resource.versionNumber ?? 1}.zip`,
    };
  }
  async selectContext(
    user: AgentUser,
    id: string,
    revision: number,
    paths: string[],
  ) {
    return adminAction(
      this.studio.store,
      user,
      'studio.skill.context_selected',
      id,
      { paths },
      async () => {
        const resource = await this.studio.store.find<StudioResource>(
          'studio-resource',
          id,
        );
        if (
          !resource ||
          resource.type !== 'skill' ||
          resource.status !== 'pending' ||
          resource.importState !== 'ready'
        )
          throw new ApiError(
            409,
            'STUDIO_SKILL_LOCKED',
            'Chỉ chỉnh ảnh ví dụ của phiên bản đang chờ duyệt. Bản đã duyệt cần nâng phiên bản mới.',
          );
        if (
          paths.length > 4 ||
          new Set(paths).size !== paths.length ||
          paths.some(
            (path) =>
              !resource.contextImages?.some((image) => image.path === path),
          )
        )
          throw new ApiError(
            400,
            'STUDIO_CONTEXT_INVALID',
            'Chọn tối đa 4 ảnh từ tài nguyên của phiên bản này.',
          );
        for (const path of paths) {
          const ref = resource.contextImages.find(
            (image) => image.path === path,
          );
          const asset = await this.studio.store.get<Asset>(
            'asset',
            ref.id,
            ref.owner,
          );
          if (asset.sha256 !== ref.sha256)
            throw new ApiError(
              409,
              'STUDIO_IMAGE_CHANGED',
              'Ảnh ví dụ đã thay đổi.',
            );
        }
        const saved = await this.studio.store.patch<StudioResource>(
          'studio-resource',
          id,
          resource.owner,
          { selectedContextPaths: paths, revision: revision + 1 },
          { revision, status: 'pending', importState: 'ready' },
        );
        if (!saved)
          throw new ApiError(
            409,
            'STUDIO_REVISION_CONFLICT',
            'Phiên bản đã thay đổi; hãy tải lại.',
          );
        return saved;
      },
    );
  }
}
