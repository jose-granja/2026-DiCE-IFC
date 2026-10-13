/** Read local bytes with FileReader's measured progress; nothing is uploaded. */
export function readContextFile(
  file: Blob,
  format: "text",
  onProgress: (percent: number | null) => void,
): Promise<string>;
export function readContextFile(
  file: Blob,
  format: "buffer",
  onProgress: (percent: number | null) => void,
): Promise<ArrayBuffer>;
export function readContextFile(
  file: Blob,
  format: "text" | "buffer",
  onProgress: (percent: number | null) => void,
): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    onProgress(0);
    reader.onprogress = (event) => onProgress(
      event.lengthComputable && event.total > 0
        ? Math.round((event.loaded / event.total) * 100)
        : null,
    );
    reader.onerror = () => reject(reader.error ?? new Error("File read failed."));
    reader.onabort = () => reject(new DOMException("File read cancelled.", "AbortError"));
    reader.onload = () => {
      onProgress(100);
      resolve(reader.result as string | ArrayBuffer);
    };
    if (format === "text") reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}
