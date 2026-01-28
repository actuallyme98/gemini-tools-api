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
  return `Product profile (from uploaded image):
  ${JSON.stringify(analysis, null, 2)}
  
  Generate exactly ${mockupCount} DIFFERENT mockup prompts.

  IMPORTANT REFERENCE RULE (ABSOLUTE - READ CAREFULLY):
- The uploaded image is a HARD, LOCKED visual reference.
- The product in ALL generated mockups MUST be a DIRECT VISUAL COPY of the uploaded image.
- Treat the uploaded product as a FIXED OBJECT that is pasted into new scenes.
- This task is STRICTLY a BACKGROUND REPLACEMENT.
- The model is NOT allowed to redraw, reconstruct, redesign, or reinterpret the product under ANY circumstances.
  
  ────────────────────────────────
  DISPLAY MODE (CRITICAL - NO ASSUMPTIONS)
  ────────────────────────────────
  - displayMode = "product_only":
    Do NOT include people.
    Do NOT include faces, hands, body parts, silhouettes, reflections, or shadows.
    Do NOT describe wearing, holding, touching, or any human interaction.
    Focus ONLY on the product itself.
  
  - displayMode = "worn":
    Include a human model wearing the EXACT product.
    The product must remain visually dominant at all times.
  
  ────────────────────────────────
  PRODUCT FOCUS RULE (VERY IMPORTANT)
  ────────────────────────────────
  - The PRODUCT must be the clear visual center of the image.
  - The image must communicate the PRODUCT clearly, NOT a lifestyle story.
  - Do NOT add any elements that visually compete with or distract from the product.
  
  ────────────────────────────────
  RULES FOR displayMode = "product_only"
  (UNIVERSAL - APPLY TO ALL PRODUCTS)
  ────────────────────────────────
  
  PRODUCT PRESERVATION (ABSOLUTE):
  - The product MUST remain 100% IDENTICAL to the uploaded image.
  - Do NOT alter, modify, or reinterpret ANY of the following:
    • shape
    • size
    • proportions
    • colors
    • pattern / graphics
    • print placement
    • material appearance
    • texture
  - No redesign, recolor, distortion, cropping, stylization, or artistic reinterpretation.
  - This is a MOCKUP BACKGROUND replacement, NOT a new product design.
  
  NO HUMAN PRESENCE:
  - Do NOT include people of any kind.
  - Do NOT include faces, hands, body parts, reflections, silhouettes, or human shadows.
  - Do NOT imply usage through interaction or motion.
  
  DISPLAY & PLACEMENT (REALISTIC ONLY):
  - Show the product ALONE.
  - Use ONLY physically realistic, commercially plausible display methods:
    • laid flat
    • neatly folded
    • hanging
    • placed on a clean, neutral surface
  - Placement must respect gravity, scale, and real-world usage.
  - Do NOT add props that touch, overlap, or interact with the product.
  
  ────────────────────────────────
  BACKGROUND RULE (CONTROLLED + DIVERSITY REQUIRED)
  ────────────────────────────────
  - Background must be SIMPLE, CLEAN, and NON-DISTRACTING.
  - Background must SUPPORT the product’s real-world function.
  - Allowed background styles:
    • plain or neutral surfaces (wood, fabric, stone, paper, glass)
    • minimal indoor environments relevant to the product category
    • soft, unobtrusive natural or indoor settings
  - Do NOT include:
    • busy scenes
    • lifestyle storytelling
    • decorative clutter
    • irrelevant environments
  
  BACKGROUND DIVERSITY (MANDATORY – VERY IMPORTANT):
  - EACH mockup MUST use a CLEARLY DIFFERENT background.
  - Background differences MUST be obvious and visually distinguishable.
  - Differences may include (but are not limited to):
    • different window frame styles or materials
    • different room contexts
    • different outdoor scenery visible through glass
    • different time of day (morning / afternoon / golden hour)
    • different daylight quality (soft, diffused, direct)
  - Changing ONLY camera angle or crop is NOT considered a different background.
  - Changing ONLY light intensity without environmental change is NOT sufficient.
  
  ────────────────────────────────
  PRODUCT-SPECIFIC FUNCTIONAL CONSTRAINTS (CRITICAL)
  ────────────────────────────────
  - The display context MUST match the product’s REAL functional use.
  
  - Window decor / suncatcher:
    • MUST be hanging in front of a window or glass surface.
    • MUST be backlit by natural daylight passing through the product.
    • Light must reveal transparency and color refraction.
    • EACH mockup MUST use a DIFFERENT window background.
    • Allowed variations:
      - different window frame styles (wood, white, modern, vintage)
      - different room contexts (kitchen, living room, sunroom)
      - different exterior scenery seen through glass
      - different daylight conditions
    • Do NOT place:
      - on tables
      - on walls without windows
      - in gardens
      - in open outdoor environments
  
  - Apparel / textiles:
    • MUST be laid flat, folded, or hung.
    • Do NOT imply wearing or human presence.
  
  - Home goods:
    • MUST be placed or folded in a clean, realistic indoor setting.
  
  - Do NOT place any product in an environment where it would not logically exist.
  
  ────────────────────────────────
  LIGHTING
  ────────────────────────────────
  - Soft, natural, commercial product photography lighting.
  - Even illumination with accurate color representation.
  - No dramatic shadows, no artificial glow, no cinematic lighting.
  
  ────────────────────────────────
  COMPOSITION
  ────────────────────────────────
  - Minimalist framing.
  - Clear subject separation.
  - The product MUST dominate the visual hierarchy.
  
  ────────────────────────────────
  STYLE CONSTRAINT
  ────────────────────────────────
  - No lifestyle narrative.
  - No emotional storytelling.
  - Pure PRODUCT PRESENTATION only.
  
  ────────────────────────────────
  RULES FOR displayMode = "worn"
  ────────────────────────────────
  - Focus on upper body or half body ONLY.
  - Face must be clearly visible.
  - Natural American lifestyle vibe.
  - The model is SECONDARY; the product is PRIMARY.
  
  SCENE PRIORITY (WORN PRODUCTS ONLY):
  - PRIORITIZE outdoor environments:
    • parks
    • public plazas
    • outdoor walkways
    • campuses
    • streets
    • open-air cafés
  - Scene must feel open, breathable, and natural.
  - Lighting should be natural daylight whenever possible.
  
  - Indoor scenes are ALLOWED ONLY IF:
    • the product theme explicitly requires it
    • OR outdoor placement would conflict with the product’s story.
  
  ADDITIONAL PEOPLE RULES:
  - At most ONE prompt may include TWO people.
  - If TWO people appear:
    • BOTH must wear the EXACT SAME product.
    • Keep the SAME product type: ${analysis.productType}
    • Keep the SAME material: ${JSON.stringify(analysis.material)}
    • Keep the SAME colors: ${analysis.primaryColors?.join(', ')}
    • Keep the SAME pattern / graphics: ${analysis.pattern}
    • Product must be visually identical in every detail.
    • No color variation, no alternate versions.
    • They must have different faces.
  - Do NOT include more than two people.

  ────────────────────────────────────────────────────────────────────────────────────────────────
  CAR VISOR SPECIAL RULE (OVERRIDE – ONLY APPLY IF productType = "car visor"):
  ────────────────────────────────────────────────────────────────────────────────────────────────
  PRODUCT TYPE CLARIFICATION:
  - The product is a CLIP-ON car visor accessory.
  - The product MUST be clipped directly onto the car sun visor.
  - Do NOT describe or imply hanging strings, cords, chains, or dangling suspension.

  DISPLAY & CAMERA DISTANCE:
  - Background MUST be close-up and tightly framed around the product.
  - Camera should be positioned at near-field distance, similar to real e-commerce product inspection.
  - The visor surface and clip mechanism must be clearly visible.

  ALLOWED ENVIRONMENTS:
  - Inside car interior ONLY.
  - Car sun visor area (primary).
  - Neutral vehicle interior materials (fabric roof lining, visor texture).
  - Background may include softly blurred windshield or car interior context.

  HUMAN PRESENCE (LIMITED OVERRIDE):
  - Human hand presence IS ALLOWED for car visor clip products ONLY.
  - Hand may:
    • hold the product near the visor before clipping
    • lightly support the visor for scale reference
  - Do NOT show:
    • face
    • body
    • reflection
    • identifiable human features
  - Hand must NOT block, cover, distort, or overlap the product design.
  - The product remains the dominant visual element at all times.

  PRODUCT PRESERVATION (ABSOLUTE):
  - The product MUST remain 100% identical to the uploaded image.
  - Do NOT alter:
    • clip structure
    • size or thickness
    • acrylic shape
    • printed image
    • colors or text
  - No bending, warping, angle distortion, or redesign.

  BACKGROUND & STYLE:
  - Background must be realistic, minimal, and non-distracting.
  - No lifestyle storytelling.
  - No driving or motion implication.
  - Lighting must be soft, natural, commercial product photography.
  - The image must communicate PRODUCT FUNCTION clearly (clip-on visor use).

  NOTE:
  This rule ONLY overrides:
  - the "NO HUMAN PRESENCE" restriction
  - the "DISTANT BACKGROUND" limitation

  All other GLOBAL RULES remain fully enforced.

  ────────────────────────────────
  THEME REQUIREMENT
  ────────────────────────────────
  - Each mockup MUST have ONE clear theme.
  - Themes MUST be DIFFERENT from each other.
  - Background, lighting, and mood must support that theme.
  - The prompt must describe the PRODUCT, not a human experience.
  
  ────────────────────────────────
  FINAL VALIDATION (MANDATORY)
  ────────────────────────────────
  - If displayMode = "product_only", ANY human presence makes the prompt INVALID.
  - If displayMode = "worn", the product must remain visually dominant.
  - If two people appear, all additional people rules MUST be satisfied.
  
  ────────────────────────────────
  GLOBAL RULES (VERY IMPORTANT)
  ────────────────────────────────
  - Keep the SAME product type: ${analysis.productType}
  - Keep the SAME material: ${JSON.stringify(analysis.material)}
  - Keep the SAME colors: ${analysis.primaryColors?.join(', ')}
  - Keep the SAME pattern / graphics: ${analysis.pattern}
  - Do NOT add or remove watermarks.
  - Do NOT mention copyrighted characters, brands, or trademarks.
  - Write EVERYTHING in Vietnamese.
  
  ────────────────────────────────
  OUTPUT
  ────────────────────────────────
  Return ONLY a JSON array of strings.
  `;
};
