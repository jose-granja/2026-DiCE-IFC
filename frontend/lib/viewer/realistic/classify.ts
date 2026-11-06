/**
 * Which family of texture an IFC material is: concrete, clay brick, timber…
 *
 * The first half of realistic materials' search. The material's own words
 * decide it — its `Name`, then its IFC4 `Category` — in English and
 * Portuguese, the two languages of this app, with Spanish and French where a
 * common word costs nothing. The IFC class only refines *where* the texture
 * goes (a floor, a wall, a roof), never *what* it is: an `IfcSlab` is not
 * concrete because it is a slab.
 *
 * Pure, so the tests can pin every word; the second half — the colour — is in
 * `choose.ts`.
 */

export type TextureFamilyId =
  | "roofTiles"
  | "tiles"
  | "brick"
  | "block"
  | "stoneMasonry"
  | "stone"
  | "wood"
  | "metal"
  | "plaster"
  | "concrete"
  | "asphalt"
  | "gravel"
  | "soil"
  | "grass"
  | "carpet"
  | "vinyl";

export type TextureFamily = {
  id: TextureFamilyId;
  /**
   * Poly Haven's own category paths ("Top/Sub/…") a texture must start with,
   * or flat category tags it must carry, to be a candidate.
   */
  paths: string[];
  tags?: string[];
};

/**
 * Words that settle a material is not to be textured: glass stays glass, and
 * what is buried inside a wall (insulation, membranes, air) has no surface
 * anyone sees. Checked first, so "glass wool" is insulation, not glass, and
 * neither is textured.
 */
const NEVER = [
  /glass|vidro|vidrio|verre|glazing|envidra/,
  /insula|isola|aislam|\beps\b|\bxps\b|\bpur\b|\bpir\b|wool|\bla de (rocha|vidro|madeira)|\bla mineral|lana mineral|laine de|rockwool|foam|espuma|cortica|cork/,
  /membrane|membrana|vapou?r|barrier|barreira|waterproof|impermeab|sealant|selante|bitumen sheet|\btela\b|\bfelt\b|feltro|geotext/,
  /\bair\b|\bar\b|cavity|caixa de ar|camara de ar|\bgap\b|void/,
];

/**
 * In order: the first family whose words match wins. Roof tiles before tiles,
 * stone masonry before masonry, and brick and block before tiles, because a
 * "tijolo cerâmico" is a brick and a "telha cerâmica" a roof tile.
 */
const FAMILIES: Array<{ family: TextureFamily; words: RegExp[] }> = [
  {
    family: { id: "roofTiles", paths: ["Ceramic/Terracotta"] },
    words: [/roof ?tile|telha|teja|tuile|shingle|roofing|cobertura ceramica/],
  },
  {
    family: { id: "stoneMasonry", paths: ["Brick & Block/Stone Block & Paver", "Stone/Walls & Rubble"] },
    words: [/rubble|alvenaria de pedra|stone wall|stonework|cantaria|silharia|ashlar/],
  },
  {
    family: { id: "brick", paths: ["Brick & Block/Clay Brick"] },
    words: [/brick|tijolo|ladrillo|brique|clay|barro|masonry|alvenaria|mamposteria|maconnerie/],
  },
  {
    family: { id: "block", paths: ["Brick & Block/Concrete Block & Paver"] },
    words: [/\bblocks?\b|bloco|bloque|parpaing|\bcmu\b|paver|pave|pavimento em blocos/],
  },
  {
    family: { id: "tiles", paths: ["Ceramic/Glazed Tiles", "Ceramic/Terrazzo & Mosaic", "Ceramic/Quarry & Unglazed"], tags: ["tiles"] },
    words: [/\btiles?\b|azulej|ceramic|ceramica|porcela|\bgres\b|mosaic|mosaico|terrazzo|ladrilho|baldosa|carrelage|mosaique/],
  },
  {
    family: { id: "stone", paths: ["Stone/Slabs & Tiles", "Stone/Cobblestone & Paving"] },
    words: [/stone|pedra|piedra|pierre|granit|marble|marmore|marmol|marbre|limestone|calcario|calizo|slate|ardosia|pizarra|basalt|sandstone|arenito|travertin|lioz|cobble|calcada|cubo/],
  },
  {
    family: { id: "wood", paths: ["Wood/Boards & Planks", "Wood/Veneer", "Wood/Engineered Wood"] },
    words: [/wood|timber|madeira|madera|\bbois\b|oak|carvalho|roble|chene|pine|pinho|pino|\bpin\b|beech|faia|walnut|nogueira|birch|cherry|maple|teak|\bteca\b|cedar|poplar|choupo|eucalypt|eucalipt|mahogany|mogno|spruce|abeto|\bfir\b|larch|larico|bamboo|bambu|sucupira|jatoba|\bipe\b|wenge|sapele|iroko|afzelia|meranti|\bash\b|freixo|plywood|contraplacado|contrachapado|\bosb\b|\bmdf\b|aglomerado|\bclt\b|glulam|lamelado|parquet|parquete|soalho|tarima|laminat|deck/],
  },
  {
    family: { id: "metal", paths: ["Metal"] },
    words: [/steel|\baco\b|acero|acier|metal|alumin|iron|ferro|hierro|\bfer\b|zinc|zinco|copper|cobre|cuivre|brass|latao|bronze|galvani|inox|stainless|corten/],
  },
  {
    family: { id: "plaster", paths: ["Concrete/Plaster & Stucco"], tags: ["plaster"] },
    words: [/plaster|reboco|estuque|gesso|gypsum|yeso|platre|stucco|estuco|render|reboque|argamassa|mortar|mortero|paint|tinta|pintura|peinture|drywall|plasterboard|pladur|placo|cartonado|\bcapoto\b|\bettics\b|etics|\beifs\b/],
  },
  {
    family: { id: "concrete", paths: ["Concrete/Cast Walls & Floors"] },
    words: [/concrete|betao|beton|hormigon|cement|cimento|cemento|screed|betonilha|\bc\d{2}\/\d{2}\b|\blc\d{2}\/\d{2}\b|precast|pre-?fabricad/],
  },
  {
    family: { id: "asphalt", paths: ["Asphalt & Bitumen/Asphalt", "Asphalt & Bitumen/Roads"] },
    words: [/asphalt|asfalto|betuminos|bituminous|tarmac|bitume/],
  },
  {
    family: { id: "gravel", paths: ["Ground & Terrain/Gravel & Pebbles"] },
    words: [/gravel|brita|gravilha|grava|gravier|seixo|pebble|ballast|balastro/],
  },
  {
    family: { id: "soil", paths: ["Ground & Terrain/Soil & Mud", "Ground & Terrain/Sand"] },
    words: [/\bsoil\b|\bearth\b|\bterra\b|tierra|\bterre\b|ground|solo|\bsand\b|areia|arena|sable|saibro|\bmud\b|lama/],
  },
  {
    family: { id: "grass", paths: ["Ground & Terrain/Grass & Vegetation", "Ground & Terrain/Forest Floor"] },
    words: [/grass|relva|cesped|gazon|lawn|turf|vegeta|green roof|cobertura ajardinada/],
  },
  {
    family: { id: "carpet", paths: ["Textiles & Leather/Carpet & Matting", "Textiles & Leather/Woven"] },
    words: [/carpet|alcatifa|moqueta|moquette|rug|tapete|fabric|tecido|textile/],
  },
  {
    family: { id: "vinyl", paths: ["Plastic & Rubber/Vinyl & Linoleum", "Plastic & Rubber/Rubber"] },
    words: [/vinyl|vinil|linoleum|linoleo|\bpvc\b|rubber|borracha|caucho|caoutchouc|epoxy|epoxi/],
  },
];

/** Lower case, accents gone ("Betão" → "betao", "Aço" → "aco"). */
export function normaliseMaterialText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_\-.,;:()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function familyOf(text: string): TextureFamily | null | "never" {
  const words = normaliseMaterialText(text);
  if (!words) return null;
  if (NEVER.some((pattern) => pattern.test(words))) return "never";
  for (const { family, words: patterns } of FAMILIES) {
    if (patterns.some((pattern) => pattern.test(words))) return family;
  }
  return null;
}

/**
 * The family of one material: its name first, then its category. A material
 * whose name says it is glass or insulation is not rescued by its category.
 */
export function classifyMaterial(material: { name: string; category?: string }): TextureFamily | null {
  for (const text of [material.name, material.category ?? ""]) {
    const family = familyOf(text);
    if (family === "never") return null;
    if (family) return family;
  }
  return null;
}

/**
 * The material of an element that shows: the first one with a family, in
 * the model's own order. A layer set lists its layers from one face to the
 * other, so a rendered wall shows its first finish, not its insulation.
 */
export function surfaceMaterial(
  materials: Array<{ name: string; category?: string }>,
): { material: { name: string; category?: string }; family: TextureFamily } | null {
  for (const material of materials) {
    const family = classifyMaterial(material);
    if (family) return { material, family };
  }
  return null;
}

/** Poly Haven's `surface_use`, as the IFC class suggests it. */
export type SurfaceUse = "floor" | "wall" | "roof" | "ground";

export function surfaceUseFor(ifcClass: string): SurfaceUse | null {
  const name = ifcClass.toLowerCase();
  if (/^ifc(slab|stair|stairflight|ramp|rampflight)/.test(name)) return "floor";
  if (/^ifcroof/.test(name)) return "roof";
  if (/^ifc(wall|curtainwall|column|beam|member|plate|footing|pile|chimney|parapet)/.test(name)) return "wall";
  if (/^ifc(geographicelement|earthworks|course|pavement|kerb)/.test(name)) return "ground";
  return null;
}

/** Whether a Poly Haven texture belongs to a family. */
export function inFamily(
  asset: { category?: string; categories?: string[] },
  family: TextureFamily,
): boolean {
  const path = asset.category ?? "";
  if (family.paths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return true;
  return Boolean(family.tags?.some((tag) => asset.categories?.includes(tag)));
}
