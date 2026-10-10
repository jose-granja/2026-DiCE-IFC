import z from "zod";

/**
 * App-wide enums and constants. Zod schemas that need these live in
 * `lib/validators/`; this file holds the raw values so both the schemas and the
 * UI read from one source.
 */

// --------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------

/** `FileList` is a DOM type, so it has to be validated structurally. */
export const FileListSchema = z.custom<FileList>(
  (v) => typeof FileList !== "undefined" && v instanceof FileList,
  { message: "Expected a file" },
);

// --------------------------------------------------------------------------
// IFC
// --------------------------------------------------------------------------

/** Schemas we claim to support. IDS `ifcVersion` uses exactly these tokens. */
export const IFC_SCHEMAS = ["IFC4", "IFC4X3_ADD2"] as const;
export type IfcSchema = (typeof IFC_SCHEMAS)[number];

/** Schemas the parser will read, including ones we only read and never author. */
export const IFC_READ_SCHEMAS = [
  "IFC2X3",
  "IFC4",
  "IFC4X1",
  "IFC4X3",
  "IFC4X3_ADD2",
] as const;

export const IFC_FILE_EXTENSIONS = [".ifc", ".ifcxml", ".ifczip"] as const;
export const BCF_FILE_EXTENSIONS = [".bcf", ".bcfzip"] as const;
export const IDS_FILE_EXTENSIONS = [".ids", ".xml"] as const;

// --------------------------------------------------------------------------
// IDS 1.0
// --------------------------------------------------------------------------

export const IDS_NAMESPACE = "http://standards.buildingsmart.org/IDS";
export const IDS_XSD_URL = "http://standards.buildingsmart.org/IDS/1.0/ids.xsd";

export const IDS_FACETS = [
  "Entity",
  "Attribute",
  "Classification",
  "Property",
  "Material",
  "PartOf",
] as const;
export type IdsFacet = (typeof IDS_FACETS)[number];

export const IDS_CARDINALITIES = ["required", "optional", "prohibited"] as const;
export type IdsCardinality = (typeof IDS_CARDINALITIES)[number];

/** XSD restriction kinds the `FormRestriction` editor can produce. */
export const XSD_RESTRICTION_KINDS = [
  "enumeration",
  "pattern",
  "bounds",
  "length",
] as const;
export type XsdRestrictionKind = (typeof XSD_RESTRICTION_KINDS)[number];

// --------------------------------------------------------------------------
// BCF 3.0
// --------------------------------------------------------------------------

export const BCF_VERSION = "3.0";

export const BCF_TOPIC_STATUSES = [
  "Open",
  "In Progress",
  "Closed",
  "ReOpened",
] as const;

export const BCF_TOPIC_TYPES = [
  "Issue",
  "Error",
  "Warning",
  "Info",
  "Clash",
  "Request",
  "Remark",
] as const;

export const BCF_PRIORITIES = ["Low", "Normal", "High", "Critical"] as const;

// --------------------------------------------------------------------------
// Georeferencing
// --------------------------------------------------------------------------

/**
 * LoGeoRef levels, as used by the `/georef` validation panel. Level 50 is the
 * only one that is unambiguous for map placement.
 */
export const LOGEOREF_LEVELS = [0, 10, 20, 30, 40, 50] as const;
export type LoGeoRefLevel = (typeof LOGEOREF_LEVELS)[number];

/**
 * Portuguese CRSs first — this app is built for PT practice. The full EPSG
 * registry is loaded on demand by `FormSelectEPSG`; these are the defaults.
 */
export const PT_PROJECTED_CRS = [
  { code: 3763, name: "ETRS89 / Portugal TM06" },
  { code: 20790, name: "Lisbon (Lisbon) / Portuguese National Grid" },
  { code: 5018, name: "Lisbon / Portuguese Grid New" },
  { code: 27493, name: "Datum 73 / Modified Portuguese Grid" },
  { code: 5013, name: "PTRA08 / UTM zone 25N (Azores W)" },
  { code: 5014, name: "PTRA08 / UTM zone 26N (Azores C)" },
  { code: 5015, name: "PTRA08 / UTM zone 28N (Madeira)" },
] as const;

export const DEFAULT_EPSG = 3763;

// --------------------------------------------------------------------------
// Signing
// --------------------------------------------------------------------------

/** Only the physical Cartão de Cidadão. CMD is deliberately out of scope. */
export const SIGNING_PROVIDERS = ["webeid", "softhsm", "mock"] as const;
export type SigningProviderId = (typeof SIGNING_PROVIDERS)[number];

export const XADES_PROFILES = ["B", "T", "LTA"] as const;
export type XadesProfile = (typeof XADES_PROFILES)[number];

/** How a batch of files is signed. See PROJECT_PROMPT §Phase 3 "Bulk mode". */
export const BULK_SIGNING_MODES = ["manifest", "per-file"] as const;
export type BulkSigningMode = (typeof BULK_SIGNING_MODES)[number];

/** Where the Autenticação.gov PKCS#11 module lives, per OS. */
export const PTEID_PKCS11_PATHS = {
  win32: "C:\\Windows\\System32\\pteidpkcs11.dll",
  darwin: "/usr/local/lib/libpteidpkcs11.dylib",
  linux: "/usr/local/lib/libpteidpkcs11.so",
} as const;

export const AUTENTICACAO_GOV_URL = "https://www.autenticacao.gov.pt/cc-aplicacao";

// --------------------------------------------------------------------------
// Navigation
// --------------------------------------------------------------------------

export const MODULES = [
  { key: "viewer", href: "/viewer" },
  { key: "idsCreate", href: "/ids/create" },
  { key: "signIfc", href: "/sign/ifc" },
  { key: "signBcf", href: "/sign/bcf" },
  { key: "verify", href: "/sign/verify" },
  { key: "signingSetup", href: "/sign/setup" },
] as const;

/**
 * Titles and descriptions live in `messages/*.json` under `modules.<key>`, not
 * here. They are user-visible prose in two languages; keeping them in a
 * constants file is what left the navigation permanently English while the
 * default locale was Portuguese.
 */
export type ModuleKey = (typeof MODULES)[number]["key"];
