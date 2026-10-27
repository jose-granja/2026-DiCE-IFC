"use client";

import { useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { MAX_SNAPSHOT_FILE_BYTES, SnapshotFileError, snapshotFromImageFile } from "@/lib/bcf/snapshot-file";

type Snapshot = { fileName: string; bytes: Uint8Array };

/**
 * Pick a picture from the computer and read it as a snapshot. Returns the
 * hidden file input to render, and `choose` to open it.
 */
export function usePictureFile(onPicture: (snapshot: Snapshot, file: File) => void | Promise<void>): {
  input: ReactNode;
  choose: () => void;
  reading: boolean;
} {
  const t = useTranslations("bcf.picture");
  const inputRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);

  const read = async (file: File) => {
    setReading(true);
    let snapshot: Snapshot;
    try {
      snapshot = await snapshotFromImageFile(file);
    } catch (error) {
      const code = error instanceof SnapshotFileError ? error.code : "unreadable";
      toast.error(t(`errors.${code}`, { name: file.name, megabytes: MAX_SNAPSHOT_FILE_BYTES / 1024 / 1024 }));
      setReading(false);
      return;
    }
    try {
      await onPicture(snapshot, file);
    } finally {
      setReading(false);
    }
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      hidden
      data-picture-input
      onChange={(event) => {
        const file = event.target.files?.[0];
        // Cleared, so the same file can be chosen again.
        event.target.value = "";
        if (file) void read(file);
      }}
    />
  );

  return { input, choose: () => inputRef.current?.click(), reading };
}
