import normalizePath from "../normalize-path.js";

// deps/zip-stream/utils.js:3-15
export function dateify(dateish?: unknown): Date {
  dateish = dateish || new Date();

  if (dateish instanceof Date) {
    dateish = dateish;
  } else if (typeof dateish === "string") {
    dateish = new Date(dateish);
  } else {
    dateish = new Date();
  }

  return dateish as Date;
}

// deps/zip-stream/utils.js:17-21
export function sanitizePath(filepath: string): string {
  return normalizePath(filepath)
    .replace(/^\w+:/, "")
    .replace(/^(\.\.\/|\/)+/, "");
}
