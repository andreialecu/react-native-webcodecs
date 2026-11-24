export interface Picked {
  name: string;
  path: string;
  size: number;
  file?: File;
}

// A file input, opened and dropped right away.
export const pickVideo = () =>
  new Promise<Picked | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*";
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(
        file
          ? { name: file.name, path: file.name, size: file.size, file }
          : null,
      );
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
