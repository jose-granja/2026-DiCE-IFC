import json, sys, ifcopenshell, ifcopenshell.guid as guid
from ifctester import ids, reporter
out = sys.argv[1]
f = ifcopenshell.file(schema="IFC4")
g = lambda: guid.new()
project = f.create_entity("IfcProject", GlobalId=g(), Name="P")
site = f.create_entity("IfcSite", GlobalId=g(), Name="S")
storey = f.create_entity("IfcBuildingStorey", GlobalId=g(), Name="L0")
f.create_entity("IfcRelAggregates", GlobalId=g(), RelatingObject=project, RelatedObjects=[site])
f.create_entity("IfcRelAggregates", GlobalId=g(), RelatingObject=site, RelatedObjects=[storey])
# id: (occurrence class, occ PT, occ ObjectType, type class, type PT, type ElementType)
CASES = {
 "C01": ("IfcWall", None, None, "IfcWallType", "STANDARD", None),
 "C02": ("IfcWall", None, None, "IfcWallType", "USERDEFINED", "X"),
 "C03": ("IfcWall", "USERDEFINED", "X", "IfcWallType", "NOTDEFINED", None),
 "C04": ("IfcWall", "PARTITIONING", None, "IfcWallType", "SOLIDWALL", None),
 "C05": ("IfcWall", None, "Basic Wall", None, None, None),
 "C06": ("IfcFurniture", None, None, "IfcFurnitureType", None, "Desk"),
 "C07": ("IfcWall", "STANDARD", None, "IfcWallType", "USERDEFINED", None),
 "C08": ("IfcWall", "NOTDEFINED", None, None, None, None),
 "C09": ("IfcWall", "USERDEFINED", None, None, None, None),
 "C10": ("IfcWall", None, "Basic Wall", "IfcWallType", "NOTDEFINED", None),
 "C12": ("IfcWall", None, "Basic Wall", "IfcWallType", "STANDARD", None),
 "C13": ("IfcWall", "USERDEFINED", "Y", "IfcWallType", "USERDEFINED", "X"),
 "C14": ("IfcWall", "STANDARD", None, None, None, None),
}
placed = []
for cid, (occ_class, occ_pt, occ_ot, type_class, type_pt, type_et) in CASES.items():
    occ = f.create_entity(occ_class, GlobalId=g(), Name=cid, ObjectType=occ_ot, PredefinedType=occ_pt)
    placed.append(occ)
    if type_class:
        t = f.create_entity(type_class, GlobalId=g(), Name=cid + "-type", ElementType=type_et, PredefinedType=type_pt)
        f.create_entity("IfcRelDefinesByType", GlobalId=g(), RelatingType=t, RelatedObjects=[occ])
# C11: a type object itself.
f.create_entity("IfcWallType", GlobalId=g(), Name="C11", ElementType="X", PredefinedType="USERDEFINED")
f.create_entity("IfcRelContainedInSpatialStructure", GlobalId=g(), RelatingStructure=storey, RelatedElements=placed)
f.write(f"{out}/cases.ifc")

VALUES = ["STANDARD", "SOLIDWALL", "PARTITIONING", "USERDEFINED", "NOTDEFINED", "X", "Y", "Basic Wall", "Desk"]
doc = ids.Ids(title="Predefined type cases")
specs = []
for cid in [*CASES, "C11"]:
    entity = "IFCWALLTYPE" if cid == "C11" else CASES[cid][0].upper()
    for value in VALUES:
        spec = ids.Specification(name=f"{cid}|{value}", ifcVersion=["IFC4"])
        spec.applicability.append(ids.Entity(name=entity))
        spec.applicability.append(ids.Attribute(name="Name", value=cid))
        spec.requirements.append(ids.Entity(name=entity, predefinedType=value))
        doc.specifications.append(spec)
doc.to_xml(f"{out}/cases.ids")
model = ifcopenshell.open(f"{out}/cases.ifc")
doc = ids.open(f"{out}/cases.ids")
doc.validate(model)
result = {s.name: ("pass" if s.status else "fail") for s in doc.specifications}
json.dump(result, open(f"{out}/ifctester.json", "w"), indent=1)
print(len(result), "specs;", sum(v == "pass" for v in result.values()), "pass")
