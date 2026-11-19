/**
 * Which `PredefinedType` an element actually has, by buildingSMART's rules.
 *
 * - **The type's comes first.** IFC4/4.3 on every occurrence's PredefinedType
 *   (e.g. `IfcWall`): it "shall only be used, if no IfcWallType is assigned,
 *   providing its own IfcWallType.PredefinedType". So a type with a value
 *   other than NOTDEFINED decides it, and the occurrence's own value, if it
 *   has one, does not apply.
 * - **Otherwise the occurrence's own** (no type, or a type that is unset or
 *   NOTDEFINED).
 * - **USERDEFINED names the real value elsewhere** (WHERE rule
 *   `CorrectPredefinedType`): the occurrence's `ObjectType`; the type's
 *   `ElementType` (`IfcElementType`, `IfcSpatialElementType`), `ProcessType`
 *   (`IfcTypeProcess`) or `ResourceType` (`IfcTypeResource`).
 *
 * This is what the properties panel shows. IDS validation reads it as
 * ifctester does instead (`ifctesterPredefinedType`, below), which agrees on
 * all of this and is more lenient in three places.
 */

export type PredefinedTypeSource = "occurrence" | "type";

export type PredefinedTypeView = {
  /** What the element is: the enumeration value, or the user-defined text for USERDEFINED. */
  value: string;
  /** The enumeration value as stored ("SOLIDWALL", "USERDEFINED", "NOTDEFINED"). */
  enumValue: string;
  source: PredefinedTypeSource;
  /** For USERDEFINED: the attribute holding the text, whether or not it is filled. */
  userDefinedIn?: string;
  /** The occurrence's own value, when the type's applies instead. */
  overridden?: string;
};

type Attributes = ReadonlyArray<{ name: string; value: unknown }>;

/** Where a type keeps its user-defined value, by its class ("IfcTaskType" → ProcessType). */
export function userDefinedAttributeOfType(typeClass: string): string {
  const name = typeClass.toLowerCase();
  if (/^ifc(task|procedure|event)type$/.test(name)) return "ProcessType";
  if (/resourcetype$/.test(name)) return "ResourceType";
  return "ElementType";
}

function attribute(attributes: Attributes, name: string): string {
  const found = attributes.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  return found?.value === undefined || found.value === null ? "" : String(found.value).trim();
}

/** An enumeration as written: "STANDARD", ".STANDARD." and "standard" are the same. */
function enumValue(attributes: Attributes, name = "PredefinedType"): string {
  return attribute(attributes, name).replace(/^\.|\.$/g, "").toUpperCase();
}

/**
 * An enumeration the type dictates, read as {@link effectivePredefinedType}
 * reads PredefinedType: the type's value when it says more than NOTDEFINED,
 * else the occurrence's own, else the type's NOTDEFINED. `occurrenceUserDefined`
 * and `typeUserDefined` name the attributes holding the text of USERDEFINED.
 */
function effectiveTypeDrivenEnum(
  occurrence: Attributes,
  type: { type: string; attributes: Attributes } | null,
  name: string,
  occurrenceUserDefined: string,
  typeUserDefined: (typeClass: string) => string,
): PredefinedTypeView | null {
  const own = enumValue(occurrence, name);
  const typed = type ? enumValue(type.attributes, name) : "";

  if (type && typed && typed !== "NOTDEFINED") {
    const userDefinedIn = typed === "USERDEFINED" ? typeUserDefined(type.type) : undefined;
    return {
      value: (userDefinedIn && attribute(type.attributes, userDefinedIn)) || typed,
      enumValue: typed,
      source: "type",
      ...(userDefinedIn ? { userDefinedIn } : {}),
      ...(own && own !== "NOTDEFINED"
        ? { overridden: own === "USERDEFINED" ? attribute(occurrence, occurrenceUserDefined) || own : own }
        : {}),
    };
  }

  if (own) {
    const userDefined = own === "USERDEFINED";
    return {
      value: (userDefined && attribute(occurrence, occurrenceUserDefined)) || own,
      enumValue: own,
      source: "occurrence",
      ...(userDefined ? { userDefinedIn: occurrenceUserDefined } : {}),
    };
  }

  // Neither says more than NOTDEFINED: the type's, since the occurrence left it unset.
  return typed ? { value: typed, enumValue: typed, source: "type" } : null;
}

/**
 * The element's predefined type, or null when neither it nor its type has one.
 * `type` is the type object (its class, "IfcWallType", and attributes), or
 * null without a type.
 */
export function effectivePredefinedType(
  occurrence: Attributes,
  type: { type: string; attributes: Attributes } | null,
): PredefinedTypeView | null {
  return effectiveTypeDrivenEnum(occurrence, type, "PredefinedType", "ObjectType", userDefinedAttributeOfType);
}

/**
 * The other enumerations a door's or a window's type dictates (IFC4, IFC4X3):
 * `IfcDoor.OperationType` from its `IfcDoorType`, `IfcWindow.PartitioningType`
 * from its `IfcWindowType`, each named by `UserDefined…` when USERDEFINED.
 * buildingSMART's BLT001 and BLT002 require the occurrence to leave it empty
 * when it has a type, so an occurrence that does shows its type's value.
 */
const TYPE_DRIVEN_ATTRIBUTES: ReadonlyArray<{ occurrence: RegExp; name: string; userDefined: string }> = [
  { occurrence: /^ifcdoor(standardcase)?$/i, name: "OperationType", userDefined: "UserDefinedOperationType" },
  { occurrence: /^ifcwindow(standardcase)?$/i, name: "PartitioningType", userDefined: "UserDefinedPartitioningType" },
];

export type TypeDrivenAttributeView = PredefinedTypeView & { name: string };

/**
 * OperationType for a door, PartitioningType for a window, as
 * {@link effectivePredefinedType} reads PredefinedType: the type's when it says
 * more than NOTDEFINED, else the occurrence's own. Empty for any other class,
 * and when neither the element nor its type has the value. (In IFC2X3 only
 * `IfcDoorStyle` has an OperationType, so a door shows its style's; a window
 * style has no PartitioningType.)
 */
export function effectiveTypeDrivenAttributes(
  occurrenceClass: string,
  occurrence: Attributes,
  type: { type: string; attributes: Attributes } | null,
): TypeDrivenAttributeView[] {
  return TYPE_DRIVEN_ATTRIBUTES.filter((entry) => entry.occurrence.test(occurrenceClass)).flatMap((entry) => {
    const view = effectiveTypeDrivenEnum(occurrence, type, entry.name, entry.userDefined, () => entry.userDefined);
    return view ? [{ name: entry.name, ...view }] : [];
  });
}

/**
 * The predefined type as ifctester reads it, for IDS validation: IfcOpenShell's
 * `util.element.get_predefined_type` and `is_userdefined_type` (0.8–0.9),
 * line for line. Validating the way the reference implementation does
 * matters more there than the schema's prose, and ifctester is more lenient
 * than `effectivePredefinedType` in three places (checked against it on the
 * same files):
 *
 * - an occurrence with no PredefinedType but an `ObjectType` counts as
 *   user-defined, named by its ObjectType;
 * - a type with no PredefinedType but an `ElementType` (or `ProcessType`)
 *   counts as user-defined, named by it;
 * - a USERDEFINED type with nothing naming it says nothing, so the
 *   occurrence's own value applies.
 *
 * `type` is the type object's attributes, or the entity's own when it is a
 * type object itself (ifctester's `get_type` returns a type as its own type);
 * null without a type. Values are compared exactly, as ifctester does.
 */
export function ifctesterPredefinedType(
  own: Attributes,
  type: Attributes | null,
): { value: string | undefined; userDefined: boolean } {
  const read = (attributes: Attributes, name: string) => {
    const value = attributes.find((entry) => entry.name === name)?.value;
    return value === undefined || value === null || value === "" ? undefined : String(value);
  };
  // `getattr(type, "ElementType", ...)`, falling back to ProcessType when the class has no ElementType.
  const typeName = (attributes: Attributes) =>
    attributes.some((entry) => entry.name === "ElementType") ? read(attributes, "ElementType") : read(attributes, "ProcessType");

  let value: string | undefined;
  let userDefined: boolean | undefined;
  if (type) {
    const predefined = read(type, "PredefinedType");
    const named = predefined === "USERDEFINED" || !predefined ? typeName(type) : predefined;
    if (named && named !== "NOTDEFINED") value = named;
    // is_userdefined_type: USERDEFINED, or no PredefinedType and a name; settled by any other real value.
    if (predefined === "USERDEFINED" || (!predefined && named)) userDefined = true;
    else if (predefined && predefined !== "NOTDEFINED") userDefined = false;
  }
  const predefined = read(own, "PredefinedType");
  if (value === undefined) value = predefined === "USERDEFINED" || !predefined ? read(own, "ObjectType") : predefined;
  if (userDefined === undefined) userDefined = predefined === "USERDEFINED" || (!predefined && Boolean(read(own, "ObjectType")));
  return { value, userDefined };
}
