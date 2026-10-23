export interface Entity {
  id: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
}
export interface AgentUser extends Entity {
  email: string;
  passwordHash?: string;
  googleSub?: string;
  disabled?: boolean;
  authVersion?: number;
  lastLoginAt?: string;
  role: 'admin' | 'designer';
}
export interface Session extends Entity {
  expiresAt: number;
  authVersion?: number;
}
export interface CompanySettings extends Entity {
  name: string;
  protectedAdminId: string;
  googleAllowedDomains: string[];
  googleAutoProvision: boolean;
  queuePaused: boolean;
}
export interface AdminAudit extends Entity {
  actorEmail: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
  outcome: 'pending' | 'success' | 'failed';
  errorCode?: string;
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
  pinnedRequirements?: string[];
  messages: {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    createdAt: string;
    runId?: string;
    attachments?: {
      sourceIds: string[];
      targetIds: string[];
      templateIds: string[];
    };
  }[];
}
export type ChatMessage = Conversation['messages'][number];
export interface MessageRecord extends Entity {
  conversationId: string;
  position: string;
  message: ChatMessage;
}
export interface ConversationMemory extends Entity {
  summary: string;
  through?: string;
  messageCount: number;
}
export interface WorkflowStep {
  name: string;
  operation: Exclude<Operation, 'auto'>;
  instructions: string;
  source: 'initial' | 'previous';
  count: number;
}
export interface CustomWorkflow extends Entity {
  name: string;
  description: string;
  revision: number;
  steps: WorkflowStep[];
  archived: boolean;
}
export interface WorkflowExecution extends Entity {
  approvalMode?: 'manual' | 'auto';
  conversationId: string;
  workflow: CustomWorkflow;
  brief: string;
  sourceIds: string[];
  targetIds: string[];
  templateIds: string[];
  productType: string;
  provider: string;
  imageModel?: string;
  runIds: string[];
  stage: number;
  research: string;
  researchSources: Run['researchSources'];
  validateVisually: boolean;
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
export type PlanQuestion = {
  question: string;
  options: { label: string; description?: string }[];
  input?: 'source' | 'reference' | 'template' | 'single_source';
};
export interface Run extends Entity {
  pendingInputs?: {
    sourceIds: string[];
    targetIds: string[];
    templateIds: string[];
  };
  approvalMode?: 'manual' | 'auto';
  autoApprovalRounds?: number;
  autoAnswers?: { question: string; answer: string }[];
  queueAdmission?: 'plan' | 'image';
  queueAdmissionReleased?: boolean;
  workflow?: {
    executionId: string;
    name: string;
    revision: number;
    stage: number;
    total: number;
  };
  context?: {
    estimatedTokens: number;
    budget: number;
    recentMessages: number;
    summarizedMessages: number;
    compactedAt?: string;
  };
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
  clarifications?: PlanQuestion[];
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
