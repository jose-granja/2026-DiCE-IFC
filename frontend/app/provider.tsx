"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";
import type z from "zod";

import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

// ---------------------------------------------------------------------------
// Query client
// ---------------------------------------------------------------------------

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Model data never comes from the network, so the only queries here are
        // small metadata reads. A short stale time keeps them cheap.
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Form schema context
// ---------------------------------------------------------------------------

/**
 * Makes the Zod schema of the current form available to every control, so
 * `FormBase` can derive `required` and the inputs can derive `minLength`,
 * `maxLength`, `min`, `max` and enum options straight from the schema instead
 * of repeating them as props.
 */
const FormSchemaContext = createContext<z.ZodObject<z.ZodRawShape> | null>(null);

export function FormSchemaProvider({
  schema,
  children,
}: {
  schema:
    | z.ZodObject<z.ZodRawShape>
    | z.ZodEffects<z.ZodObject<z.ZodRawShape>>;
  children: React.ReactNode;
}) {
  // Unwrap ZodEffects (`.refine()` / `.superRefine()`) to reach the object.
  const baseSchema =
    "sourceType" in schema
      ? (schema.sourceType() as z.ZodObject<z.ZodRawShape>)
      : schema;

  return (
    <FormSchemaContext.Provider value={baseSchema}>
      {children}
    </FormSchemaContext.Provider>
  );
}

export function useFormSchema(fieldName: string) {
  const schema = useContext(FormSchemaContext);
  return schema?.shape[fieldName];
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export default function Providers({
  children,
  nonce,
}: {
  children: React.ReactNode;
  /** From proxy.ts, so next-themes' pre-paint script satisfies the CSP. */
  nonce?: string;
}) {
  const [queryClient] = useState(makeQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        nonce={nonce}
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <TooltipProvider>
          {children}
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
