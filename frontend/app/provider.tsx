"use client";

import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { jwtDecode } from "jwt-decode";
import { toast } from "sonner";
import type z from "zod";

import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getCurrentUser, peekAccessToken, signOut } from "@/lib/actions/auth";
import type { JwtPayload, User } from "@/types";

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
// Auth
// ---------------------------------------------------------------------------

type AuthContextValue = {
  user: User | null;
  jwtPayload: JwtPayload | null;
  roles: string[];
  isLoading: boolean;
  error: unknown;
  signOut: () => void;
  refetchUser: () => void;
};

const AuthCtx = createContext<AuthContextValue>({
  user: null,
  jwtPayload: null,
  roles: [],
  isLoading: false,
  error: null,
  signOut: () => {},
  refetchUser: () => {},
});

export const useAuth = () => useContext(AuthCtx);

function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const t = useTranslations("nav");

  const userQuery = useQuery({
    queryKey: ["user"],
    queryFn: getCurrentUser,
  });

  // The claims (`is_staff`, `roles`) live in the access token, not in
  // `/users/me/`. Keyed on the user so it re-reads after a sign-in.
  const claimsQuery = useQuery({
    queryKey: ["jwt-claims", userQuery.data?.user?.id ?? null],
    queryFn: async () => {
      const token = await peekAccessToken();
      if (!token) return null;
      try {
        return jwtDecode<JwtPayload>(token);
      } catch {
        return null;
      }
    },
  });

  const signOutMutation = useMutation({
    mutationFn: signOut,
    onMutate: () => {
      toast.loading(t("signingOut"), { id: "sign-out" });
    },
    onSuccess: () => {
      toast.success(t("signedOut"), { id: "sign-out" });
      userQuery.refetch();
      router.push("/sign-in");
      router.refresh();
    },
    onError: () => {
      toast.error(t("signOutFailed"), { id: "sign-out" });
    },
  });

  const value = useMemo<AuthContextValue>(
    () => ({
      user: userQuery.data?.user ?? null,
      jwtPayload: claimsQuery.data ?? null,
      roles: claimsQuery.data?.roles ?? [],
      isLoading: userQuery.isLoading || claimsQuery.isLoading,
      error: userQuery.error ?? claimsQuery.error ?? null,
      signOut: () => signOutMutation.mutate(),
      refetchUser: () => {
        userQuery.refetch();
        claimsQuery.refetch();
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      userQuery.data,
      userQuery.isLoading,
      userQuery.error,
      claimsQuery.data,
      claimsQuery.isLoading,
      claimsQuery.error,
    ],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
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
          <AuthProvider>{children}</AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
