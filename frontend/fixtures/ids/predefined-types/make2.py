import json, sys, ifcopenshell, ifcopenshell.guid as guid
from ifctester import ids
out = sys.argv[1]
f = ifcopenshell.open(f"{out}/cases.ifc")
g = lambda: guid.new()
# partOf parents: element assemblies with each kind of predefined type, each aggregating a member.
PARENTS = {
 "P1": dict(PredefinedType="TRUSS"),
 "P2": dict(PredefinedType="USERDEFINED", ObjectType="Frame"),
 "P3": dict(ObjectType="Frame"),
 "P4": dict(PredefinedType="NOTDEFINED"),
}
for pid, attrs in PARENTS.items():
    parent = f.create_entity("IfcElementAssembly", GlobalId=g(), Name=pid + "-parent", **attrs)
    child = f.create_entity("IfcMember", GlobalId=g(), Name=pid)
    f.create_entity("IfcRelAggregates", GlobalId=g(), RelatingObject=parent, RelatedObjects=[child])
f.write(f"{out}/cases2.ifc")
R = lambda **o: ids.Restriction(options=o)
CONSTRAINTS = {
 "enum[USERDEFINED]": lambda: R(enumeration=["USERDEFINED"]),
 "enum[X,STANDARD]": lambda: R(enumeration=["X", "STANDARD"]),
 "pattern[USER.*]": lambda: R(pattern="USER.*"),
 "pattern[Basic.*]": lambda: R(pattern="Basic.*"),
 "pattern[[A-Z]+]": lambda: R(pattern="[A-Z]+"),
}
doc = ids.Ids(title="Predefined type cases 2")
for cid in ["C01", "C02", "C03", "C05", "C06", "C07", "C09", "C13"]:
    entity = "IFCFURNITURE" if cid == "C06" else "IFCWALL"
    for label, make in CONSTRAINTS.items():
        spec = ids.Specification(name=f"{cid}|{label}", ifcVersion=["IFC4"])
        spec.applicability.append(ids.Entity(name=entity))
        spec.applicability.append(ids.Attribute(name="Name", value=cid))
        spec.requirements.append(ids.Entity(name=entity, predefinedType=make()))
        doc.specifications.append(spec)
for pid in PARENTS:
    for value in ["TRUSS", "USERDEFINED", "Frame", "NOTDEFINED"]:
        spec = ids.Specification(name=f"{pid}|partOf {value}", ifcVersion=["IFC4"])
        spec.applicability.append(ids.Entity(name="IFCMEMBER"))
        spec.applicability.append(ids.Attribute(name="Name", value=pid))
        spec.requirements.append(ids.PartOf(name="IFCELEMENTASSEMBLY", predefinedType=value, relation="IFCRELAGGREGATES"))
        doc.specifications.append(spec)
doc.to_xml(f"{out}/cases2.ids")
model = ifcopenshell.open(f"{out}/cases2.ifc")
doc = ids.open(f"{out}/cases2.ids")
doc.validate(model)
json.dump({s.name: ("pass" if s.status else "fail") for s in doc.specifications}, open(f"{out}/ifctester2.json", "w"), indent=1)
print(len(doc.specifications), "specs")
