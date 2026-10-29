import type { Entity } from '../agent/agent.types';
import type { StudioAssetRef, StudioSlot } from './studio.types';

export interface MockupInput {
  requestKey: string;
  title: string;
  storeId: string;
  productId: string;
  sources: {
    assetId: string;
    ticketId?: string;
    sceneIds: string[];
    colors: string[];
  }[];
  provider: 'shopaikey' | 'gemini';
  imageModel: string;
  instructions: string;
  backgrounds?: { id: string; name: string; prompt: string }[];
}
export interface MockupSource {
  image: StudioAssetRef;
  ticketId?: string;
  sceneIds: string[];
  colors: string[];
}
export interface MockupScene {
  id: string;
  name: string;
  instructions: string;
  kind?: 'template' | 'background';
  image?: StudioAssetRef;
}
export interface StudioMockup extends Entity {
  teamId: string;
  storeId: string;
  title: string;
  inputHash: string;
  product: { id: string; code: string; name: string };
  sources: MockupSource[];
  scenes: MockupScene[];
  provider: 'shopaikey' | 'gemini';
  imageModel: string;
  instructions: string;
  count: number;
  state:
    | 'queued'
    | 'running'
    | 'review'
    | 'partial_failed'
    | 'failed'
    | 'blocked'
    | 'cancelled';
  error?: string;
}
export interface StudioMockupSlot extends Omit<StudioSlot, 'ticketId'> {
  jobId: string;
  sourceIndex: number;
  sceneId: string;
  color: string;
}
