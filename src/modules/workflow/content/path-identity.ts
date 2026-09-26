import { resolve } from "node:path";

/** 以正規化、大小寫不敏感、separator 不敏感的路徑身分比較；碰撞時宁可保留。 */
export function pathIdentityKey(path: string): string {
  return resolve(path).normalize("NFC").replace(/[\\/]+/g, "/").toLocaleLowerCase("en-US");
}

export function samePathIdentity(left: string, right: string): boolean {
  return pathIdentityKey(left) === pathIdentityKey(right);
}
