export interface Entity {
  id: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
}
export interface AgentUser extends Entity {
  email: string;
  passwordHash: string;
  role: 'admin' | 'designer';
}
export interface Session extends Entity {
  expiresAt: number;
}
export interface Asset extends Entity {
  name: string;
  category: string;
  kind: 'source' | 'reference' | 'design' | 'template' | 'result';
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  parentId?: string;
  revision: number;
  review: 'draft' | 'approved' | 'changes_requested';
  runId?: string;
  stepId?: string;
  checks?: {
    technical: boolean;
    visual: 'not_checked' | 'pass' | 'review';
    notes: string[];
  };
  storageKey: string;
  iv: string;
  tag: string;
}
export type Point = { x: number; y: number };
export interface MockupTemplate extends Entity {
  name: string;
  category: string;
  assetId: string;
  corners: [Point, Point, Point, Point];
  opacity: number;
  blend: 'over' | 'multiply';
  maskAssetId?: string;
  overlayAssetId?: string;
  revision: number;
}
export interface Conversation extends Entity {
  title: string;
  messages: {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    createdAt: string;
    runId?: string;
  }[];
}
export type Operation = 'auto' | 'mockup_ai' | 'mockup_template' | 'design';
export type RunState =
  | 'planning'
  | 'needs_input'
  | 'draft'
  | 'queued'
  | 'running'
  | 'review'
  | 'completed'
  | 'partial_failed'
  | 'failed'
  | 'cancelled';
export interface PlanItem {
  title: string;
  prompt: string;
  sourceId?: string;
  targetId?: string;
  templateId?: string;
  templateSnapshot?: MockupTemplate;
}
export interface Run extends Entity {
  queuePrepared?: boolean;
  conversationId: string;
  brief: string;
  operation: Operation;
  state: RunState;
  provider: string;
  imageModel?: string;
  sourceIds: string[];
  targetIds: string[];
  templateIds: string[];
  count: number;
  productType: string;
  research: string;
  researchSources: { title: string; url: string; retrievedAt: string }[];
  summary: string;
  questions: string[];
  items: PlanItem[];
  analyses: Record<string, unknown>;
  validateVisually: boolean;
  requestId: string;
}
export interface Step extends Entity {
  runId: string;
  type: 'plan' | 'image';
  state: 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
  index: number;
  input?: PlanItem;
  resultId?: string;
  error?: string;
  errorCode?: string;
  startedAt?: string;
  workerId?: string;
  leaseUntil?: number;
  slotId?: string;
  slotToken?: string;
  durationMs?: number;
  requestId: string;
}
