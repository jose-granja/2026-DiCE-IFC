/**
 * File System Access API pieces TypeScript's DOM lib does not declare yet.
 *
 * `FileSystemFileHandle` and `FileSystemDirectoryHandle` are already in lib.dom
 * (OPFS uses them); only the picker entry points are missing. Kept minimal and
 * deliberately narrow — this is a shim for a real API, not an abstraction, and
 * it should shrink to nothing as the DOM lib catches up.
 */

interface OpenFilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: OpenFilePickerAcceptType[];
  /** Well-known directory, or a handle to start in. */
  startIn?: FileSystemHandle | string;
  /** Groups the "last used directory" memory per id. */
  id?: string;
}

interface SaveFilePickerOptions extends OpenFilePickerOptions {
  suggestedName?: string;
}

interface Window {
  showOpenFilePicker?(
    options?: OpenFilePickerOptions,
  ): Promise<FileSystemFileHandle[]>;

  showSaveFilePicker?(
    options?: SaveFilePickerOptions,
  ): Promise<FileSystemFileHandle>;

  showDirectoryPicker?(options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: FileSystemHandle | string;
  }): Promise<FileSystemDirectoryHandle>;
}

interface FileSystemHandle {
  /**
   * Permission state for a persisted handle. Required by workspace restore:
   * a handle read back from OPFS after a reload has to be re-authorised before
   * its file can be read.
   */
  queryPermission?(descriptor?: {
    mode?: "read" | "readwrite";
  }): Promise<PermissionState>;

  requestPermission?(descriptor?: {
    mode?: "read" | "readwrite";
  }): Promise<PermissionState>;
}
