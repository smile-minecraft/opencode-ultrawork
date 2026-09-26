import { resolve, sep } from "node:path";
import { assertContainedPath } from "../../kit/path-guard.ts";

/** 全域 `.ultrawork` 路徑的嚴格 containment；測試的非 `.ultrawork` fixture 不受影響。 */
export function assertSafeGlobalUltraworkPath(targetPath: string): string {
  const target = resolve(targetPath);
  const marker = `${sep}.ultrawork${sep}`;
  const markerIndex = target.indexOf(marker);
  if (markerIndex < 0) return target;
  return assertContainedPath(target.slice(0, markerIndex), target, {
    label: "Skills path guard",
  });
}
