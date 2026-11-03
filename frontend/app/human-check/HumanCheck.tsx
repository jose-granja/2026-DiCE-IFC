"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, RotateCcw, ShieldCheck, ShieldX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TURNSTILE_ACTION, TURNSTILE_SCRIPT, VERIFY_PATH } from "@/lib/human-check/pass";

/**
 * The Turnstile widget, and what happens once it is solved: the token goes to
 * `/api/human-check`, which sets the pass, and the visitor goes on to the page
 * they asked for. Loaded the way the CDE's login CAPTCHA is — the script only
 * on this page, explicit rendering, one widget per attempt.
 */

type Turnstile = {
  render(element: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<void> | null = null;

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("Turnstile could not be loaded."));
    };
    document.head.appendChild(script);
  });
  return loading;
}

type Status = "loading" | "ready" | "verifying" | "passed" | "failed" | "unavailable";

export function HumanCheck({ siteKey, next, locale }: { siteKey: string; next: string; locale: string }) {
  const t = useTranslations("humanCheck");
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let active = true;

    const submit = async (token: string) => {
      if (!active) return;
      setStatus("verifying");
      try {
        const response = await fetch(VERIFY_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          cache: "no-store",
        });
        if (!active) return;
        if (response.ok) {
          setStatus("passed");
          // A full load, so the pass cookie is on every request from here on.
          window.location.replace(next);
          return;
        }
        setStatus(response.status === 502 ? "unavailable" : "failed");
      } catch {
        if (active) setStatus("unavailable");
      }
    };

    loadTurnstile()
      .then(() => {
        const element = box.current;
        if (!active || !element || !window.turnstile) return;
        widget.current = window.turnstile.render(element, {
          sitekey: siteKey,
          action: TURNSTILE_ACTION,
          language: locale,
          theme: "auto",
          callback: (token: string) => void submit(token),
          "expired-callback": () => active && setStatus("ready"),
          "error-callback": () => {
            if (active) setStatus("failed");
            // Handled: without a return value Turnstile also logs and retries on its own.
            return true;
          },
        });
        setStatus("ready");
      })
      .catch(() => {
        if (active) setStatus("unavailable");
      });

    return () => {
      active = false;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, next, locale]);

  const retry = () => {
    if (widget.current && window.turnstile) {
      window.turnstile.reset(widget.current);
      setStatus("ready");
    } else {
      window.location.reload();
    }
  };

  return (
    <div className="space-y-3" data-human-check-status={status}>
      <div ref={box} className="flex min-h-[65px] justify-center" data-turnstile />
      {status === "loading" && <Line icon={<Loader2 className="h-4 w-4 animate-spin" />} text={t("loading")} />}
      {status === "verifying" && <Line icon={<Loader2 className="h-4 w-4 animate-spin" />} text={t("verifying")} />}
      {status === "passed" && <Line icon={<ShieldCheck className="h-4 w-4 text-emerald-600" />} text={t("passed")} />}
      {(status === "failed" || status === "unavailable") && (
        <div className="space-y-2" role="alert">
          <Line
            icon={<ShieldX className="text-destructive h-4 w-4" />}
            text={t(status === "failed" ? "failed" : "unavailable")}
          />
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t("retry")}
          </Button>
        </div>
      )}
    </div>
  );
}

function Line({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <p className="text-muted-foreground flex items-start gap-2 text-sm" aria-live="polite">
      <span className="mt-0.5 shrink-0">{icon}</span>
      {text}
    </p>
  );
}
