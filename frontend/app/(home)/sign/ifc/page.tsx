"use client";

import { useTranslations } from "next-intl";

import SignModule from "../_components/SignModule";
import { IFC_FILE_EXTENSIONS } from "@/config";

export default function SignIfcPage() {
  const t = useTranslations("signPages.ifc");
  return (
    <SignModule
      kind="ifc"
      title={t("title")}
      description={t("description")}
      accept={[...IFC_FILE_EXTENSIONS]}
    />
  );
}
