export type AICapability = 'text' | 'vision' | 'image';

export interface AIInputImage {
  base64: string;
  mimeType: string;
}

export interface EditImageParams {
  imageModel?: string;
  base64Image: string;
  mimeType: string;
  prompt: string;
}

export interface ReferenceImagesParams {
  imageModel?: string;
  productImageBase64: string;
  productMimeType: string;
  referenceImages?: AIInputImage[];
  variations?: number;
  variationIndex?: number;
}

export interface BackgroundReplacementParams {
  imageModel?: string;
  /** Source product whose surface artwork is transferred without redesign. */
  productImage: AIInputImage;
  /** Base photo to edit in place, preserving its subjects and scene. */
  backgroundImage: AIInputImage;
  /** Complete user-edited prompt, forwarded verbatim without a hidden base. */
  instructions: string;
  variationIndex?: number;
}

export interface GeneratedImage {
  buffer: Buffer;
  mimeType: string;
}

export interface AIImageModelCatalog {
  provider: string;
  defaultModel: string | null;
  models: { id: string; name: string }[];
}

/** Implement this contract and register the adapter in AI_PROVIDERS. */
export interface AIProvider {
  readonly id: string;
  readonly name?: string;
  readonly capabilities: readonly AICapability[];
  validateConfiguration(capability: AICapability): void;
  generateJSON(prompt: string, image?: AIInputImage): Promise<unknown>;
  generateImage?(prompt: string, imageModel?: string): Promise<Buffer>;
  getImageModels?(refresh?: boolean): Promise<AIImageModelCatalog>;
  editImage?(params: EditImageParams): Promise<Buffer>;
  generateImagesFromReferalImages?(
    params: ReferenceImagesParams,
  ): Promise<Buffer[]>;
  replaceBackground?(
    params: BackgroundReplacementParams,
  ): Promise<GeneratedImage>;
}

export const AI_PROVIDERS = Symbol('AI_PROVIDERS');

export interface AIProviderCatalog {
  textRouting?: { primary: string; fallback: string; healthRequired: true };
  defaults: Record<AICapability, string>;
  providers: {
    id: string;
    name: string;
    available: boolean;
    capabilities: AICapability[];
    routing: Record<AICapability, string | null>;
  }[];
}
