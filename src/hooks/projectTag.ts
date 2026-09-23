import path from "node:path";

export interface KnownLocation {
  project_tag: string;
  cwd: string | null;
}

// The form in which two tags are "the same" as far as a typed message is
// concerned — case-insensitive, with -, _ and whitespace interchangeable,
// exactly as the router matches mentions. Registration checks uniqueness in
// this form, so a tag that's unique in the database is also unambiguous
// when typed.
export function normalizeTag(tag: string): string {
  return tag.toLowerCase().split(/[-_\s]+/).filter(Boolean).join(" ");
}

// Derives a human-friendly project name from a working directory,
// disambiguating against any other known session or registered project whose
// folder shares the same basename but is actually a different directory
// (e.g. two projects both named "identity" under different parents).
export function deriveProjectTag(cwd: string, known: KnownLocation[] = []): string {
  const base = path.basename(cwd) || cwd;
  const collision = known.find(
    (k) => k.cwd && k.cwd !== cwd && normalizeTag(k.project_tag) === normalizeTag(base),
  );
  if (!collision) return base;

  const parent = path.basename(path.dirname(cwd));
  return `${base} (${parent})`;
}
