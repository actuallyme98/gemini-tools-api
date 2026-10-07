export type AICapability = 'text' | 'vision' | 'image';

export interface AIInputImage {
  base64: string;
  mimeType: string;
}

export interface EditImageParams {
  base64Image: string;
  mimeType: string;
  prompt: string;
}

export interface ReferenceImagesParams {
  productImageBase64: string;
  productMimeType: string;
  referenceImages?: AIInputImage[];
  variations?: number;
  variationIndex?: number;
}

/** Implement this contract and register the adapter in AI_PROVIDERS. */
export interface AIProvider {
  readonly id: string;
  readonly name?: string;
  readonly capabilities: readonly AICapability[];
  validateConfiguration(capability: AICapability): void;
  generateJSON(prompt: string, image?: AIInputImage): Promise<unknown>;
  generateImage?(prompt: string): Promise<Buffer>;
  editImage?(params: EditImageParams): Promise<Buffer>;
  generateImagesFromReferalImages?(
    params: ReferenceImagesParams,
  ): Promise<Buffer[]>;
}

export const AI_PROVIDERS = Symbol('AI_PROVIDERS');

export interface AIProviderCatalog {
  defaults: Record<AICapability, string>;
  providers: {
    id: string;
    name: string;
    available: boolean;
    capabilities: AICapability[];
    routing: Record<AICapability, string>;
  }[];
}
