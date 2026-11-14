"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Box, Loader2 } from "lucide-react";

import { EXAMPLE_MODEL, fetchExampleModel } from "@/lib/viewer/example-model";
import { loadModelFiles } from "@/lib/viewer/loader";
import { Button } from "@/components/ui/button";

/** Opens the example model, for a visitor with no IFC of their own at hand. */
export default function ExampleModelButton() {
  const t = useTranslations("viewer.example");
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    try {
      const [result] = await loadModelFiles([await fetchExampleModel()]);
      if (result && !result.ok) toast.error(t("failed", { error: result.error }));
    } catch (error) {
      toast.error(t("failed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={open}
      disabled={busy}
      aria-busy={busy}
      title={EXAMPLE_MODEL.name}
      data-example-model
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Box className="h-4 w-4" aria-hidden />}
      {busy ? t("opening") : t("open")}
    </Button>
  );
}
