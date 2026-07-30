import catalogJson from "../assets/skins.json";
import type { AnimName } from "./types";
import type { SheetMeta } from "./frame-player";

export type SkinKind = "sprite" | "frames";

/** skins.json 条目：新皮肤 = 清单一条 + assets 资源 */
export interface SkinMeta {
  key: string;
  name: string;
  kind: SkinKind;
  /** sprites/ 下文件名 */
  sprite?: string;
  /** frames/ 下目录名 */
  frames?: string;
  /** 帧动画名列表（kind=frames） */
  anims?: string[];
}

export interface SkinOption {
  key: string;
  name: string;
  /** 配置面板缩略图 URL */
  url: string;
}

const SKIN_CATALOG = catalogJson as SkinMeta[];

const SPRITES = import.meta.glob("../assets/sprites/*.png", {
  eager: true,
  import: "default",
}) as Record<string, string>;

const FRAME_PNG = import.meta.glob("../assets/frames/*/*.png", {
  eager: true,
  import: "default",
}) as Record<string, string>;

const FRAME_JSON = import.meta.glob("../assets/frames/*/*.json", {
  eager: true,
  import: "default",
}) as Record<string, SheetMeta>;

function pathEndsWith(p: string, suffix: string): boolean {
  const n = p.replace(/\\/g, "/");
  return n.endsWith(suffix) || n.includes(`/${suffix}`);
}

function findSprite(filename: string): string | undefined {
  const hit = Object.entries(SPRITES).find(([p]) => pathEndsWith(p, filename));
  return hit?.[1];
}

function findFrameAsset(
  dir: string,
  anim: string,
): { sheet: string; meta: SheetMeta } | undefined {
  const sheet = Object.entries(FRAME_PNG).find(([p]) =>
    pathEndsWith(p, `frames/${dir}/${anim}.png`),
  )?.[1];
  const meta = Object.entries(FRAME_JSON).find(([p]) =>
    pathEndsWith(p, `frames/${dir}/${anim}.json`),
  )?.[1];
  if (!sheet || !meta) return undefined;
  return { sheet, meta };
}

function findPoster(dir: string): string | undefined {
  return Object.entries(FRAME_PNG).find(([p]) =>
    pathEndsWith(p, `frames/${dir}/_poster.png`),
  )?.[1];
}

export function listSkinCatalog(): SkinMeta[] {
  return SKIN_CATALOG.map((s) => ({ ...s }));
}

export function skinPosterUrl(meta: SkinMeta): string {
  if (meta.kind === "sprite" && meta.sprite) return findSprite(meta.sprite) ?? "";
  if (meta.kind === "frames" && meta.frames) return findPoster(meta.frames) ?? "";
  return "";
}

/** 配置面板皮肤列表 */
export function listSkinOptions(): SkinOption[] {
  return SKIN_CATALOG.map((m) => ({
    key: m.key,
    name: m.name,
    url: skinPosterUrl(m),
  }));
}

/** 静态精灵皮肤 → URL（PetRenderer） */
export function buildSpriteUrls(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of SKIN_CATALOG) {
    if (m.kind !== "sprite" || !m.sprite) continue;
    const u = findSprite(m.sprite);
    if (u) out[m.key] = u;
  }
  return out;
}

/** 帧动画皮肤 → 各状态精灵表（PetRenderer） */
export function buildFrameSkins(): Record<
  string,
  Partial<Record<AnimName, { sheet: string; meta: SheetMeta }>>
> {
  const out: Record<
    string,
    Partial<Record<AnimName, { sheet: string; meta: SheetMeta }>>
  > = {};
  for (const m of SKIN_CATALOG) {
    if (m.kind !== "frames" || !m.frames) continue;
    const anims = m.anims?.length ? m.anims : ["idle"];
    const map: Partial<Record<AnimName, { sheet: string; meta: SheetMeta }>> = {};
    for (const a of anims) {
      const def = findFrameAsset(m.frames, a);
      if (def) map[a as AnimName] = def;
    }
    out[m.key] = map;
  }
  return out;
}
