import type { AgentStore } from '../agent/agent.store';
import type { AgentUser, Asset } from '../agent/agent.types';
import { ApiError } from '../common/api-error';
import type { StudioStore, StudioTeam, StudioTicket } from './studio.types';
import type { StudioMockup } from './studio-mockup.types';

// Also called by legacy image endpoints, so switching routes cannot bypass revoked Studio access.
export async function assertStudioAssetAccess(
  store: AgentStore,
  asset: Asset,
  actorId: string,
) {
  if (!asset.studioTicketId && !asset.studioMockupId) return;
  const ticket = asset.studioMockupId
    ? await store.find<StudioMockup>('studio-mockup', asset.studioMockupId)
    : await store.find<StudioTicket>('studio-ticket', asset.studioTicketId);
  const shop =
    ticket && (await store.find<StudioStore>('studio-store', ticket.storeId));
  const team =
    shop && (await store.find<StudioTeam>('studio-team', shop.teamId));
  const user = await store.find<AgentUser>('user', actorId);
  const role = team?.members.find((member) => member.userId === actorId)?.role;
  if (
    !user ||
    user.disabled ||
    !ticket ||
    !shop ||
    shop.archived ||
    !team ||
    team.archived ||
    (user.role !== 'admin' &&
      (!role || (role !== 'leader' && !shop.sellerIds.includes(actorId))))
  )
    throw new ApiError(
      404,
      'STUDIO_NOT_FOUND',
      'Ảnh thuộc cửa hàng bạn không còn quyền truy cập.',
    );
}
