"""
The kinds of material the library covers, as the viewer classifies them
(frontend/lib/viewer/realistic/classify.ts): the same sixteen ids.

For each: where its textures are found in both libraries, the surface it
usually is, how many textures to propose, and its usual roughness (for a
texture that publishes none).
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Family:
    id: str
    # Poly Haven category paths ("Top/Sub/…") a texture must start with, or flat tags it must carry.
    polyhaven_paths: tuple[str, ...]
    # ambientCG asset-id prefixes (`Bricks076C` → `Bricks`).
    ambientcg_prefixes: tuple[str, ...]
    surface: str
    count: int
    roughness: float
    polyhaven_tags: tuple[str, ...] = ()
    # ambientCG tags that rule an asset out of this family.
    ambientcg_exclude_tags: tuple[str, ...] = field(default=())


FAMILIES: tuple[Family, ...] = (
    Family("roofTiles", ("Ceramic/Terracotta",), ("RoofingTiles",), "roof", 8, 0.75),
    Family("stoneMasonry", ("Brick & Block/Stone Block & Paver", "Stone/Walls & Rubble"), ("Rocks",), "wall", 8, 0.85),
    Family("brick", ("Brick & Block/Clay Brick",), ("Bricks", "PaintedBricks"), "wall", 14, 0.85),
    Family("block", ("Brick & Block/Concrete Block & Paver",), (), "wall", 6, 0.9),
    Family(
        "tiles",
        ("Ceramic/Glazed Tiles", "Ceramic/Terrazzo & Mosaic", "Ceramic/Quarry & Unglazed"),
        ("Tiles", "Terrazzo", "GlazedTerracotta"),
        "floor",
        12,
        0.35,
        polyhaven_tags=("tiles",),
    ),
    Family("stone", ("Stone/Slabs & Tiles", "Stone/Cobblestone & Paving"), ("Marble", "Granite", "Travertine", "PavingStones"), "floor", 10, 0.55),
    Family("wood", ("Wood/Boards & Planks", "Wood/Veneer", "Wood/Engineered Wood"), ("WoodFloor", "Planks", "WoodSiding", "Wood"), "floor", 16, 0.65),
    Family("metal", ("Metal",), ("Metal", "MetalPlates", "CorrugatedSteel", "PaintedMetal", "SheetMetal"), "wall", 10, 0.45),
    Family("plaster", ("Concrete/Plaster & Stucco",), ("Plaster", "PaintedPlaster"), "wall", 14, 0.9, polyhaven_tags=("plaster",)),
    Family("concrete", ("Concrete/Cast Walls & Floors",), ("Concrete",), "wall", 14, 0.85),
    Family("asphalt", ("Asphalt & Bitumen/Asphalt", "Asphalt & Bitumen/Roads"), ("Asphalt", "Road"), "floor", 5, 0.95),
    Family("gravel", ("Ground & Terrain/Gravel & Pebbles",), ("Gravel",), "floor", 5, 0.95),
    Family("soil", ("Ground & Terrain/Soil & Mud", "Ground & Terrain/Sand"), ("Ground",), "floor", 6, 1.0, ambientcg_exclude_tags=("grass", "moss", "leaves", "snow")),
    Family("grass", ("Ground & Terrain/Grass & Vegetation", "Ground & Terrain/Forest Floor"), ("Grass", "Moss"), "floor", 5, 0.95),
    Family("carpet", ("Textiles & Leather/Carpet & Matting", "Textiles & Leather/Woven"), ("Carpet",), "floor", 8, 1.0),
    Family("vinyl", ("Plastic & Rubber/Vinyl & Linoleum", "Plastic & Rubber/Rubber"), ("Plastic", "Rubber"), "floor", 8, 0.5),
)

BY_ID = {family.id: family for family in FAMILIES}

SURFACES = ("wall", "floor", "roof")

# Walls and floors are seen up close, so they get 2K too (ADR 016, decision 3).
def sizes_for(surface: str) -> tuple[int, ...]:
    return (1024, 2048) if surface in ("wall", "floor") else (1024,)
