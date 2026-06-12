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
    analysis.displayMode === 'worn'
      ? [
          '- Include a human model wearing the EXACT product. Upper body or half body, face visible. Natural American lifestyle vibe. Product is PRIMARY, model is SECONDARY.',
          '- Prioritize outdoor environments (parks, plazas, walkways, streets, open-air cafes). Indoor only if product theme requires it.',
          '- At most ONE prompt may include TWO people - both must wear the identical product (same type/material/colors/pattern), different faces. No more than two people total.',
        ].join('\n')
      : [
          '- Show product ALONE. NO human presence of any kind - no faces, hands, body parts, silhouettes, shadows, or reflections.',
          '- Use only realistic display methods: flat lay, folded, hanging, or placed on a clean neutral surface. No props touching or overlapping the product.',
          '- Background: simple, clean, non-distracting - plain surfaces (wood, fabric, stone, paper, glass) or minimal indoor settings.',
        ].join('\n');

  return `Generate exactly ${mockupCount} DIFFERENT mockup prompts for this product:
${JSON.stringify(analysis)}

=== ABSOLUTE RULE - READ FIRST ===
This task is STRICTLY a BACKGROUND REPLACEMENT. The product MUST appear as a FIXED, UNCHANGED OBJECT pasted into a new scene.
The model is FORBIDDEN from redrawing, redesigning, restyling, reinterpreting, or reimagining the product in ANY way.
The product in every mockup MUST be a DIRECT VISUAL COPY of the reference image - identical in:
  - shape, size, and proportions
  - all colors and color placement
  - all printed graphics, patterns, and artwork
  - print size and position on the product
  - material appearance and texture
  - borders, trims, and finishing details
Any mockup that alters the product in any of the above ways is INVALID and must be discarded.

=== BACKGROUND DIVERSITY (REQUIRED) ===
Each of the ${mockupCount} mockups MUST have a clearly different background/setting/theme.
Changing only camera angle, crop, or light intensity does NOT count as a different background.
Each mockup must have one distinct theme that is visually distinguishable from all others.

=== DISPLAY MODE: "${analysis.displayMode}" ===
${displayModeRules}

=== DISPLAY & PLACEMENT RULES ===
- Placement must respect gravity, real-world scale, and realistic product usage.
- Do NOT show the product in a context where it would not logically exist.
- Do NOT add props, objects, or decorative elements that touch, overlap, or distract from the product.
- The product MUST dominate the visual hierarchy of the image at all times.

=== PRODUCT-SPECIFIC OVERRIDES (apply only when relevant) ===
- Window decor / suncatcher: MUST hang in front of a window, backlit by natural daylight showing transparency and color refraction. Different window frame style per mockup (wood, white, modern, vintage). Never on tables, walls without windows, or outdoors.
- Apparel / textiles: laid flat, folded, or hung only. Do NOT imply wearing, holding, or human interaction.
- Car visor (clip-on, productType = "car visor"): Inside car interior ONLY. Product MUST be clipped directly onto the sun visor. A hand MAY hold or lightly support the visor but must NOT cover or overlap the product design. No face, body, or motion. Close-up, tightly framed around the product.
- Home goods: placed or folded in a clean, realistic indoor setting only.

=== LIGHTING & COMPOSITION ===
- Soft, natural, commercial product photography lighting.
- Even illumination with accurate color representation.
- No dramatic shadows, no artificial glow, no cinematic or moody lighting.
- Minimalist framing. Clear subject separation. Product dominates the frame.

=== RESTRICTIONS ===
- No lifestyle storytelling or emotional narrative.
- No copyrighted characters, brands, trademarks, logos, or watermarks.
- Do NOT add or remove any text, graphics, or markings on the product.
- No elements that compete with or visually distract from the product.

=== FINAL VALIDATION (check every prompt before outputting) ===
- Is the product visually identical to the reference image? If NO, rewrite.
- If displayMode = "product_only": any human presence = INVALID, rewrite.
- If displayMode = "worn": is the product still the dominant visual element? If NO, rewrite.
- Is this background clearly different from all other mockups in the set? If NO, rewrite.

OUTPUT: Return ONLY a JSON array of strings. Write EVERYTHING in Vietnamese.`;
};
