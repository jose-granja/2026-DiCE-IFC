import Link from "next/link";
import { useTranslations } from "next-intl";

export default function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const t = useTranslations("auth");
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
          DiCE-IFC
        </Link>
        <span className="text-muted-foreground text-xs">
          {t("signInOnlyNotice")}
        </span>
      </header>
      <main className="flex flex-1 items-center justify-center p-6 md:p-10">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
