import type { Entity } from './agent.types';

export type ProjectRole = 'viewer' | 'editor' | 'reviewer' | 'manager';
export interface Project extends Entity {
  name: string;
  description: string;
  memberIds: string[];
  members: { id: string; email: string; role: ProjectRole }[];
  archived: boolean;
}
export interface JobComment extends Entity {
  runId: string;
  authorEmail: string;
  text: string;
  action: 'comment' | 'approved' | 'changes_requested';
  assetId?: string;
}
export interface Knowledge extends Entity {
  title: string;
  content: string;
  tags: string[];
  visibility: 'private' | 'company' | 'project';
  projectId?: string;
  revision: number;
  archived: boolean;
}
export interface EvaluationCase extends Entity {
  name: string;
  sourceId: string;
  targetId?: string;
  requirements: string;
  expectedCount: number;
}
export interface EvaluationResult extends Entity {
  currency?: 'USD' | 'CREDIT';
  caseId: string;
  runId: string;
  model: string;
  promptHash: string;
  score: number;
  notes: string;
  durationMs: number;
  costUsd: number;
  unresolved: number;
}
