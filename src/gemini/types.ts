export interface ImageAnalysis {
  productCategory: string;
  productType: string;
  primaryColors: string[];
  pattern: string;
  styleKeywords: string[];
  mood: string;
  audience: string;
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
