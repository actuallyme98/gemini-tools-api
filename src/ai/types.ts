export interface ImageAnalysis {
  productCategory: string;
  productType: string;
  displayMode: string;
  primaryColors: string[];
  pattern: string;
  styleKeywords: string[];
  mood: string;
  audience: string;
  inspiredBy?: {
    source: string;
    theme: string;
    setting: string;
    styleReference: string;
  };
  characters?: {
    hasCharacters: boolean;
    characterNames: string[];
    characterType: string[];
    numberOfCharacters: number;
    relationship: string;
    visualDescription: string;
  };
  material: {
    main: string;
    details: string;
    texture: string;
    weightOrThickness: string;
    flexibility: string;
    breathability: string;
    seasonSuitability: string[];
  };
}

export interface Idea {
  title: string;
  description: string;
  prompt: string;
}
