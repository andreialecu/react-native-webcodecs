import type { NativeFile } from "../specs/WebCodecs.nitro";

import { native, rethrow, toArrayBuffer } from "./native";
import { installStreams } from "./streams";

/** The absolute path a path resolves to (a relative one: the cache directory). */
export const resolvePath = (path: string) => native().resolvePath(path);

/** Deletes a file; false when there was none. */
export const removeFile = (path: string) => native().removeFile(path);

/** Writes bytes to a file at once and returns its absolute path. */
export const writeFile = (path: string, data: ArrayBuffer | ArrayBufferView) =>
  native().writeFile(path, toArrayBuffer(data));

type FileChunk = { type: "write"; data: Uint8Array; position: number };

export interface FileWritable {
  /** For Mediabunny: `new StreamTarget(file.writable, { chunked: true })`. */
  readonly writable: WritableStream<FileChunk>;
  /** The absolute path of the file. */
  readonly path: string;
  /**
   * Closes the file if needed and deletes it: after `output.cancel()`, which
   * closes the stream as finalize() would, this removes the partial file.
   */
  remove(): Promise<boolean>;
}

/**
 * A file written as Mediabunny's StreamTarget produces it, without holding
 * the whole output in memory. An aborted stream deletes the partial file;
 * Mediabunny's `output.cancel()` closes it instead, so follow it with
 * `file.remove()`.
 */
export const createFileWritable = (path: string): FileWritable => {
  // Hermes has no WHATWG streams: ours becomes the global WritableStream,
  // the one Mediabunny's StreamTarget checks with `instanceof`.
  const Writable = installStreams();
  let file: NativeFile;
  try {
    file = native().openFile(path, true);
  } catch (e) {
    return rethrow(e);
  }
  const writable = new Writable<FileChunk>({
    write: (chunk: FileChunk) =>
      file.write(chunk.position, toArrayBuffer(chunk.data)),
    close: () => file.close(),
    abort: async () => {
      await file.close().catch(() => undefined);
      native().removeFile(file.path);
    },
  });
  return {
    writable,
    path: file.path,
    remove: () =>
      file
        .close()
        .catch(() => undefined)
        .then(() => native().removeFile(file.path)),
  };
};

/**
 * Options for Mediabunny's CustomSource that read a file natively, in the
 * ranges Mediabunny asks for: `new Input({ source: new CustomSource(
 * fileSourceOptions(path)), formats: ALL_FORMATS })`.
 */
export const fileSourceOptions = (path: string) => {
  let file: NativeFile;
  try {
    file = native().openFile(path, false);
  } catch (e) {
    return rethrow(e);
  }
  return {
    getSize: () => file.size,
    read: async (start: number, end: number) =>
      new Uint8Array(await file.read(start, end)),
    dispose: () => {
      file.close().catch(() => undefined);
    },
    prefetchProfile: "fileSystem" as const,
  };
};
