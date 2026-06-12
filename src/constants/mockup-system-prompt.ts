import { ImageAnalysis } from 'src/gemini/types';

export const ANALYZE_PRODUCT_FROM_IMAGE_PROMPT = `
IMPORTANT RULES:
- The image may contain clothing or non-clothing products.
- Determine the PRIMARY product being sold, not supporting or staging objects.
- Determine productCategory and productType FIRST, before analyzing visuals, characters, or themes.

DISPLAY MODE RULE:
- displayMode = "worn" → product is worn on a human body
- displayMode = "product_only" → product is shown alone (placed, flat-lay, displayed)
- Electronic accessories (phone grips, phone stands, holders) are ALWAYS "product_only".

────────────────────────────
FUNCTIONAL IDENTIFICATION RULE (CRITICAL):
- Classify a product as "Phone Grip / Phone Stand" ONLY IF:
  - There is visible evidence of an expandable, collapsible, hinged, or support mechanism, AND
  - The structure is designed to assist holding, gripping, or propping up a phone.
- Decorative illustrations, characters, acrylic art, or printed graphics
  DO NOT determine the productType.

────────────────────────────
ATTACHMENT METHOD IDENTIFICATION (VERY IMPORTANT):
- Identify how the product attaches to the phone:
  - "magnetic" → MagSafe-style alignment, circular magnetic base, no adhesive pad visible
  - "adhesive" → glue or sticky pad
  - "mechanical" → clips, clamps, or physical holders
- If magnetic attachment is visually indicated or strongly implied,
  classify productType as "Magnetic Phone Grip / Phone Stand".
- If unclear, default to "Phone Grip / Phone Stand"
  and explain uncertainty in material.details.

────────────────────────────
FUNCTION OVER DECORATION PRIORITY RULE:
- If a product has BOTH:
  - a functional structure (grip, stand, holder), AND
  - a decorative surface (character illustration, themed artwork),
  ALWAYS classify the product by its FUNCTION first.
  Example:
  "Magnetic Phone Grip with Decorative Character Illustration"

────────────────────────────
CHARACTER & THEME ANALYSIS RULE (REQUIRED):
- If characters are depicted, ALWAYS analyze them and return full details.
- Identify and return:
  - characterNames (explicit names if clearly recognizable)
  - characterType (e.g. princess, beast, prince, royal couple)
  - numberOfCharacters
  - relationship (e.g. romantic couple)
  - visualDescription (pose, clothing, interaction, emotion)

────────────────────────────
THEME & INSPIRED-BY RULE (REQUIRED):
- Identify the overall theme or inspiration.
- If the design resembles a known IP or story:
  - Return the name in inspiredBy.source
  - Still classify product independently of IP
- Inspired-by data does NOT affect productCategory or productType.

────────────────────────────
MATERIAL INFERENCE RULE (CRITICAL):
- Infer materials based on structure, rigidity, surface finish, and common manufacturing practices.
- For phone grips / stands:
  - material.main typically includes plastic, acrylic, magnetic components
- Avoid vague terms when reasonable inference is possible.

────────────────────────────
OUTPUT RULE:
- Return ONLY valid JSON
- No explanations, no markdown, no extra text

JSON FORMAT:
{
  "productCategory": "",
  "productType": "",
  "displayMode": "",
  "primaryColors": [],
  "pattern": "",
  "styleKeywords": [],
  "mood": "",
  "audience": "",
  "inspiredBy": {
    "source": "",
    "theme": "",
    "setting": "",
    "styleReference": ""
  },
  "characters": {
    "hasCharacters": false,
    "characterNames": [],
    "characterType": [],
    "numberOfCharacters": 0,
    "relationship": "",
    "visualDescription": ""
  },
  "material": {
    "main": "",
    "details": "",
    "texture": "",
    "weightOrThickness": "",
    "flexibility": "",
    "breathability": "",
    "seasonSuitability": []
  }
}
`;

export const toGenerateMockupPrompts = (
  analysis: ImageAnalysis,
  mockupCount: number,
) => {
  const displayModeRules =
    analysis.displayMode === ‘worn’
      ? ‘- Include a human model wearing the EXACT product. Upper body or half body, face visible. Natural American lifestyle vibe. Product is PRIMARY, model is SECONDARY.\n’ +
        ‘- Prioritize outdoor environments (parks, plazas, walkways, streets, open-air cafés). Indoor only if product theme requires it.\n’ +
        ‘- At most ONE prompt may include TWO people — both must wear the identical product (same type/material/colors/pattern), different faces. No more than two people total.’
      : ‘- Show product ALONE. NO human presence of any kind — no faces, hands, body parts, silhouettes, shadows, or reflections.\n’ +
        ‘- Use only realistic display methods: flat lay, folded, hanging, or placed on a clean neutral surface. No props touching or overlapping the product.\n’ +
        ‘- Background: simple, clean, non-distracting — plain surfaces (wood, fabric, stone, paper, glass) or minimal indoor settings.’;

  return `Generate exactly ${mockupCount} DIFFERENT mockup prompts for this product:
${JSON.stringify(analysis)}

CORE RULE: This is BACKGROUND REPLACEMENT ONLY. The product in ALL mockups MUST be a 100% identical visual copy of the reference image — same shape, size, proportions, colors, pattern, print placement, material, and texture. No redesign, recolor, distortion, or reinterpretation.

BACKGROUND DIVERSITY (REQUIRED): Each mockup MUST have a visually distinct background. Changing only camera angle or light intensity does NOT count as a different background. Each mockup MUST have one clear, different theme.

DISPLAY MODE = "${analysis.displayMode}":
${displayModeRules}

PRODUCT-SPECIFIC OVERRIDES (apply only when relevant):
- Window decor / suncatcher: MUST hang in front of a window, backlit by natural daylight showing transparency and color refraction. Different window frame style per mockup. Never on tables or walls without windows.
- Apparel / textiles: laid flat, folded, or hung only. No human interaction implied.
- Car visor (clip-on, productType = "car visor"): Inside car interior ONLY. Clipped to sun visor. A hand MAY hold or lightly support the visor but must NOT cover the product design. No face, body, or motion. Close-up, tightly framed.

LIGHTING & COMPOSITION: Soft, natural, commercial product photography lighting. Even illumination, accurate colors. No dramatic shadows or cinematic lighting. Minimalist framing — product dominates the visual hierarchy.

RESTRICTIONS: No lifestyle storytelling. No copyrighted characters, brands, trademarks, or watermarks. No elements competing with or distracting from the product.

VALIDATION: displayMode = "product_only" → any human presence = INVALID. displayMode = "worn" → product must remain visually dominant.

OUTPUT: Return ONLY a JSON array of strings. Write EVERYTHING in Vietnamese.`;
};
