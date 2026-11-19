import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type StyleProfile, StyleProfileSchema } from "@cutkiller/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const PROFILES_DIR = join(REPO_ROOT, "profiles");
export const PRESETS_DIR = join(REPO_ROOT, "presets");

/** Loads a profile by id (`short`, `long`) or by path to a YAML/JSON file. */
export async function loadProfile(idOrPath: string): Promise<StyleProfile> {
  const path = existsSync(idOrPath) ? idOrPath : join(PROFILES_DIR, `${idOrPath}.yaml`);
  if (!existsSync(path)) throw new Error(`profil introuvable : ${idOrPath}`);
  const raw = parseYaml(await readFile(path, "utf8")) as unknown;
  const parsed = StyleProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `profil invalide (${path}) : ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

export async function listProfiles(): Promise<string[]> {
  return (await readdir(PROFILES_DIR))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => f.replace(/\.yaml$/, ""));
}

const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/);

export const PresetSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  version: SemVer,
  kind: z.enum(["motion", "transition", "captions", "sfx", "look"]),
  description: z.string().optional(),
  params: z.record(z.string(), z.unknown()).default({}),
});

export type Preset = z.infer<typeof PresetSchema>;

const FILE_RE = /^([a-z0-9-]+)@(\d+\.\d+\.\d+)\.json$/;

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Named, versioned presets. Files are `<kind>/<name>@<x.y.z>.json`; an EDL refers to
 * `name@x` (latest x.*.*), `name@x.y` or an exact `name@x.y.z`. A breaking change to
 * a preset must bump its major version so existing EDLs keep rendering identically.
 */
export class PresetRegistry {
  private readonly byName = new Map<string, Preset[]>();

  static async load(dir = PRESETS_DIR): Promise<PresetRegistry> {
    const registry = new PresetRegistry();
    if (!existsSync(dir)) return registry;
    for (const kind of await readdir(dir, { withFileTypes: true })) {
      if (!kind.isDirectory()) continue;
      for (const file of await readdir(join(dir, kind.name))) {
        const match = FILE_RE.exec(file);
        if (!match) continue;
        const preset = PresetSchema.parse(JSON.parse(await readFile(join(dir, kind.name, file), "utf8")));
        if (preset.name !== match[1] || preset.version !== match[2] || preset.kind !== kind.name) {
          throw new Error(`preset ${kind.name}/${file} : nom, version ou type incohérent avec le fichier`);
        }
        registry.add(preset);
      }
    }
    return registry;
  }

  add(preset: Preset): void {
    const list = this.byName.get(preset.name) ?? [];
    if (list.some((p) => p.version === preset.version))
      throw new Error(`preset dupliqué ${preset.name}@${preset.version}`);
    list.push(preset);
    list.sort((a, b) => compareSemver(a.version, b.version));
    this.byName.set(preset.name, list);
  }

  resolve(ref: string): Preset {
    const [name, range = ""] = ref.split("@");
    const candidates = (name && this.byName.get(name)) || [];
    const parts = range.split(".").filter(Boolean);
    const matching = candidates.filter((p) => parts.every((part, i) => p.version.split(".")[i] === part));
    const found = matching.at(-1);
    if (!found) throw new Error(`preset introuvable : ${ref}`);
    return found;
  }

  all(): Preset[] {
    return [...this.byName.values()].flat();
  }
}

const LookTextureSchema = z
  .object({
    grain: z.number().min(0).max(0.3),
    vignette: z.number().min(0).max(1),
    halation: z.number().min(0).max(1),
    bloom: z.number().min(0).max(1),
    letterbox: z.number().min(1).max(4),
  })
  .partial();

/**
 * The profile with an image style: its look (`presets/look/`) and the film texture
 * the look comes with (grain, vignette, halation, bloom), the profile's letterbox
 * kept unless the look sets one. Every other threshold is the profile's.
 */
export function withLook(profile: StyleProfile, registry: PresetRegistry, ref: string): StyleProfile {
  const preset = registry.resolve(ref.includes("@") ? ref : `${ref}@1`);
  if (preset.kind !== "look") throw new Error(`${ref} n'est pas un style d'image (presets/look/)`);
  const texture = LookTextureSchema.parse(preset.params.texture ?? {});
  return {
    ...profile,
    color: { ...profile.color, look: `${preset.name}@${preset.version.split(".")[0]}` },
    texture: { ...profile.texture, ...texture },
  };
}

/** Image styles shipped (look presets), with their description. */
export function listLooks(registry: PresetRegistry): { ref: string; description: string }[] {
  return registry
    .all()
    .filter((p) => p.kind === "look")
    .map((p) => ({ ref: `${p.name}@${p.version.split(".")[0]}`, description: p.description ?? "" }));
}
