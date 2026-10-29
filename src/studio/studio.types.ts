import type { Entity } from '../agent/agent.types';
export type StudioPrintSpec = {
  width: number;
  height: number;
  dpi: number;
  background: 'transparent' | 'white';
};

export interface StudioTeam extends Entity {
  name: string;
  members: { userId: string; role: 'seller' | 'leader' }[];
  memberIds: string[];
  revision: number;
  archived: boolean;
}
export interface StudioStore extends Entity {
  teamId: string;
  name: string;
  sellerIds: string[];
  productIds: string[];
  revision: number;
  archived: boolean;
}
export interface StudioResource extends Entity {
  printSpec?: StudioPrintSpec;
  teamId: string;
  type: 'product' | 'skill' | 'thumbnail' | 'scene';
  name: string;
  code: string;
  instructions: string;
  assetId?: string;
  documents?: { path: string; content: string }[];
  files?: { path: string; sha256: string; bytes: number }[];
  bundleHash?: string;
  bundleId?: string;
  seriesId?: string;
  versionNumber?: number;
  previousId?: string;
  declaredVersion?: string;
  importState?: 'preparing' | 'ready' | 'failed';
  warnings?: string[];
  contextImages?: (StudioAssetRef & { path: string })[];
  selectedContextPaths?: string[];
  activeDocumentPaths?: string[];
  issues: string[];
  status: 'pending' | 'approved' | 'archived';
  revision: number;
}
export interface IdeaInput {
  artworkFirst?: boolean;
  title: string;
  storeId: string;
  productId: string;
  skillId: string;
  thumbnailId: string;
  sourceId: string;
  sourceUrl: string;
  brief: string;
  count: number;
  sampleCount?: number;
  timing: 'now' | 'night';
  provider: 'shopaikey' | 'gemini';
  imageModel: string;
}
export interface StudioIdea extends Entity {
  teamId: string;
  input: IdeaInput;
  revision: number;
  state: 'draft' | 'pending' | 'approved' | 'changes_requested';
  reviewNote: string;
  approvedBy?: string;
  ticketId?: string;
  snapshot?: StudioSnapshot;
  dueAt?: string;
}
export type StudioAssetRef = { id: string; owner: string; sha256: string };
export interface StudioSnapshot {
  input: IdeaInput;
  product: Pick<
    StudioResource,
    'id' | 'code' | 'name' | 'instructions' | 'printSpec'
  >;
  skill: Pick<
    StudioResource,
    | 'id'
    | 'code'
    | 'name'
    | 'instructions'
    | 'documents'
    | 'bundleHash'
    | 'versionNumber'
    | 'declaredVersion'
  >;
  thumbnail: Pick<StudioResource, 'id' | 'code' | 'name' | 'instructions'>;
  source: StudioAssetRef;
  master: StudioAssetRef;
  hash: string;
  contextImages?: (StudioAssetRef & { path: string })[];
  planningVersion?: 1;
}
export interface StudioTicket extends Entity {
  occurrenceId?: string;
  batchId?: string;
  claimedAt?: string;
  catchUpAt?: string;
  dispatchCount?: number;
  teamId: string;
  storeId: string;
  ideaId: string;
  ideaRevision: number;
  approvedBy: string;
  snapshot: StudioSnapshot;
  dueAt: string;
  state:
    | 'scheduled'
    | 'queued'
    | 'running'
    | 'review'
    | 'sample_review'
    | 'partial_failed'
    | 'failed'
    | 'missed'
    | 'blocked'
    | 'cancelled';
  error?: string;
}
export interface StudioSlot extends Entity {
  role?: 'artwork' | 'thumbnail';
  dependsOn?: string;
  artworkId?: string;
  errorCode?: string;
  attemptId?: string;
  ticketId: string;
  teamId: string;
  index: number;
  state:
    | 'queued'
    | 'preparing'
    | 'submitted'
    | 'done'
    | 'failed'
    | 'interrupted'
    | 'cancelled';
  prompt: string;
  requestId: string;
  resultId?: string;
  error?: string;
  leaseUntil?: number;
}
export interface StudioReview extends Entity {
  teamId: string;
  ticketId: string;
  assetId: string;
  decision: 'approved' | 'changes_requested';
  note: string;
  revision: number;
}

export interface StudioBundle extends Entity {
  teamId: string;
  gridId: string;
  iv: string;
  tag: string;
  sha256: string;
  bytes: number;
}
export interface CreativeBrief {
  title: string;
  direction: string;
  composition: string;
  palette: string;
  prompt: string;
}
export interface SourceAnalysis {
  summary: string;
  invariants: string[];
  editable: string[];
  sourceArtifacts: string[];
  risks: string[];
}
export interface StudioPlanStep extends Entity {
  errorCode?: string;
  ticketId: string;
  phase: 'analysis' | 'briefs';
  state:
    | 'queued'
    | 'preparing'
    | 'submitted'
    | 'done'
    | 'failed'
    | 'interrupted'
    | 'cancelled';
  requestId: string;
  leaseUntil?: number;
  attemptId?: string;
  error?: string;
  analysis?: SourceAnalysis;
  briefs?: CreativeBrief[];
}
export interface StudioOccurrence extends Entity {
  day: string;
  dueAt: string;
  cutoffAt: string;
  windowEndsAt: string;
  timezone: 'Asia/Ho_Chi_Minh';
}
export interface StudioSchedule extends Entity {
  dailyTime: string;
  revision: number;
}
export interface StudioBatch extends Entity {
  occurrenceId: string;
  teamId: string;
  day: string;
  dueAt: string;
}
