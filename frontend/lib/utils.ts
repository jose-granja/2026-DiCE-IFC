import { FileListSchema } from "@/config";
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { z, ZodDateCheck, ZodNumberCheck } from "zod";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Visible text of an HTML fragment (rich-text fields). Strips tags and decodes
// entities so we can count/validate the real character length, not the markup.
// Mirrors the backend's richtext.plain_text so client and server agree.
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  const withoutTags = html.replace(/<[^>]*>/g, "");
  let text = withoutTags;
  if (typeof document !== "undefined") {
    const el = document.createElement("textarea");
    el.innerHTML = withoutTags;
    text = el.value;
  } else {
    text = withoutTags
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }
  return text.trim();
}

export function toISODate(d?: Date) {
  return d ? new Date(d).toISOString().slice(0, 10) : "";
}
export function formatDateTimeInTZ(
  d?: Date | string | number,
  timeZone = "UTC"
): string {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(p => p.type === type)?.value ?? "";

  return `${get("day")}-${get("month")}-${get("year")} ${get("hour")}:${get("minute")} ${timeZone}`;
}

export function isValidEmail(email: string): boolean {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();

  // Overall length per RFC is max 254
  if (trimmed.length === 0 || trimmed.length > 254) return false;

  // Quick structural check
  const basic = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!basic.test(trimmed)) return false;

  const [local, domain] = trimmed.split("@");
  if (!local || !domain) return false;

  // Local part: ≤ 64 chars, allowed chars, no leading/trailing dot, no consecutive dots
  if (local.length > 64) return false;
  const localPartPattern = /^(?!\.)(?!.*\.\.)[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+(?<!\.)$/;
  if (!localPartPattern.test(local)) return false;

  // Domain: labels 1–63 chars, alnum+hyphen, no leading/trailing hyphen
  const labels = domain.split(".");
  if (labels.length < 2) return false; // need at least one dot
  if (labels.some(l => l.length === 0 || l.length > 63)) return false;

  const labelPattern = /^(?!-)[A-Za-z0-9-]+(?<!-)$/;
  if (labels.some(l => !labelPattern.test(l))) return false;

  // TLD should contain at least one letter (rejects pure-numeric TLDs)
  const tld = labels[labels.length - 1];
  if (!/[A-Za-z]/.test(tld)) return false;

  return true;

}





export const emptyStringToUndefined = (v: unknown) =>
  v === null || (typeof v === "string" && v.trim() === "") ? undefined : v;

export const emptyFileListToUndefined = (v: unknown) => {
  if (typeof FileList !== "undefined" && v instanceof FileList && v.length === 0) {
    return undefined;
  }
  return v;
};

// optional string with min when present
export const optionalString = (min: number, max: number) =>
  z.preprocess(
    emptyStringToUndefined,
    z.string().min(min).max(max).optional()
  );


  // optional number when present; "" -> undefined
export const optionalNumber = (min: number, max: number) => z.preprocess(
  (v) => (v === "" || v === null ? undefined : v),
  z.coerce.number().min(min).max(max).optional()
);

// accept a non-empty FileList, or a URL string, or undefined
export const UrlString = z.string().url();
export const FileOrUrlOptional = z.preprocess(
  (v) => emptyStringToUndefined(emptyFileListToUndefined(v)),
  z.union([/* your */ FileListSchema, UrlString]).optional()
);


export const OptionalEnum = <T extends readonly [string, ...string[]]>(vals: T) =>
  z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.enum(vals).optional()
  )

export function isZodIssueArray(v: unknown): v is z.ZodIssue[] {
  return Array.isArray(v) && v.every(
    (i) => i && typeof i === "object" && "message" in (i as never) && "code" in (i as never)
  );
}

export function toMessages(v: unknown): string[] {
  if (isZodIssueArray(v)) return v.map((i) => {return `${i.path}: ${i.message}`});
  if (typeof v === "string") return [v];
  if (v == null) return ["Unknown error"];
  try { return [JSON.stringify(v)]; } catch { return ["Unknown error"]; }
}

export function getMaxLength(schema: z.ZodTypeAny): number | undefined {
  const hasMaxLength = z.object({ maxLength: z.number() }).safeParse(schema)
  if (hasMaxLength.success) return hasMaxLength.data.maxLength

  if ('unwrap' in schema && typeof schema.unwrap === 'function')
    return getMaxLength(schema.unwrap())
}

export function getMinLength(schema: z.ZodTypeAny): number | undefined {
  const hasMinLength = z.object({ minLength: z.number() }).safeParse(schema)
  if (hasMinLength.success) return hasMinLength.data.minLength

  if ('unwrap' in schema && typeof schema.unwrap === 'function')
    return getMinLength(schema.unwrap())
}
export function getMin(schema: z.ZodTypeAny): number | undefined {
  // First unwrap if it's optional/nullable
  let unwrapped = schema;
  while ('unwrap' in unwrapped && typeof unwrapped.unwrap === 'function') {
    unwrapped = unwrapped.unwrap();
  }
  
  // Check the internal type name instead of instanceof
  if (unwrapped._def?.typeName === 'ZodNumber') {
    const minCheck = unwrapped._def.checks?.find(
      (check: ZodNumberCheck) => check.kind === "min"
    );
    if (minCheck) return minCheck.value;
  }
  
  return undefined;
}

export function getMax(schema: z.ZodTypeAny): number | undefined {
  let unwrapped = schema;
  while ('unwrap' in unwrapped && typeof unwrapped.unwrap === 'function') {
    unwrapped = unwrapped.unwrap();
  }
  
  if (unwrapped._def?.typeName === 'ZodNumber') {
    const maxCheck = unwrapped._def.checks?.find(
      (check: ZodNumberCheck) => check.kind === "max"
    );
    if (maxCheck) return maxCheck.value;
  }
  
  return undefined;
}

export function getStep(schema: z.ZodTypeAny): number | undefined {
  let unwrapped = schema;
  while ('unwrap' in unwrapped && typeof unwrapped.unwrap === 'function') {
    unwrapped = unwrapped.unwrap();
  }
  
  if (unwrapped._def?.typeName === 'ZodNumber') {
    const stepCheck = unwrapped._def.checks?.find(
      (check: ZodNumberCheck) => check.kind === "multipleOf"
    );
    if (stepCheck) return stepCheck.value;
  }
  
  return undefined;
}



function unwrapEnumBase(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;

  // 1. Unwrap ZodEffects (preprocess/refine/transform)
  while (current._def?.typeName === "ZodEffects") {
    // ZodEffects stores inner schema in _def.schema
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    current = (current as z.ZodEffects<any>)._def.schema;
  }

  // 2. Unwrap optional / nullable via .unwrap()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  while ("unwrap" in current && typeof (current as any).unwrap === "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const next = (current as any).unwrap();
    if (next === current) break;
    current = next;
  }

  // 3. Unwrap ZodDefault (if you ever use .default() on enums)
  if (current._def?.typeName === "ZodDefault") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    current = (current as any)._def.innerType;
  }

  return current;
}

export function getEnumValues(
  schema: z.ZodTypeAny
): readonly string[] | undefined {
  const unwrapped = unwrapEnumBase(schema);

  // ZodEnum: prefer _def.values
  if (unwrapped._def?.typeName === "ZodEnum") {
    return (unwrapped as z.ZodEnum<[string, ...string[]]>)._def.values;
  }

  // Fallback: some Zod enums expose .options
  if ("options" in unwrapped) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (unwrapped as any).options as readonly string[];
  }

  return undefined;
}


export function getSchemaForPath(root: z.ZodTypeAny, path: string): z.ZodTypeAny | undefined {
  // degree[0].degree_type -> ["degree", "0", "degree_type"]
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".");

  let current: z.ZodTypeAny | undefined = root;

  for (const part of parts) {
    if (!current) return undefined;

    if (current instanceof z.ZodObject) {
      current = current.shape[part];
    } else if (current instanceof z.ZodArray) {
      // ignore numeric index; just go to element type
      current = current._def.type;
    } else {
      return undefined;
    }
  }
  return current;
}

// export function getEnumValues(schema: z.ZodTypeAny): readonly string[] | undefined {
//   // First unwrap if it's optional/nullable
//   let unwrapped = schema;
//   while ('unwrap' in unwrapped && typeof unwrapped.unwrap === 'function') {
//     unwrapped = unwrapped.unwrap();
//   }
  
//   // Check if it's a ZodEnum
//   if (unwrapped._def?.typeName === 'ZodEnum') {
//     return unwrapped._def.values;
//   }
  
//   // Alternative: use .options property if available
//   if ('options' in unwrapped) {
//     return unwrapped.options as readonly string[];
//   }
  
//   return undefined;
// }

export function getMinDate(schema: z.ZodTypeAny): Date | undefined {
  // First unwrap if it's optional/nullable
  let unwrapped = schema;
  while ('unwrap' in unwrapped && typeof unwrapped.unwrap === 'function') {
    unwrapped = unwrapped.unwrap();
  }
  
  // Check if it's a ZodDate
  if (unwrapped._def?.typeName === 'ZodDate') {
    const minCheck = unwrapped._def.checks?.find(
      (check: ZodDateCheck) => check.kind === "min"
    );
    if (minCheck) return new Date(minCheck.value);
  }
  
  return undefined;
}

export function getMaxDate(schema: z.ZodTypeAny): Date | undefined {
  let unwrapped = schema;
  while ('unwrap' in unwrapped && typeof unwrapped.unwrap === 'function') {
    unwrapped = unwrapped.unwrap();
  }
  
  if (unwrapped._def?.typeName === 'ZodDate') {
    const maxCheck = unwrapped._def.checks?.find(
      (check: ZodDateCheck) => check.kind === "max"
    );
    if (maxCheck) return new Date(maxCheck.value);
  }
  
  return undefined;
}


// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const hasErrors = (errorObj: Record<string, any>): boolean => {
  return Object.keys(errorObj).length > 0;
};