/** 八個業務模組的槽位清單：後續任務只改各自資料夾，不碰共用檔案。 */

import { commentSignalModule } from "./comment-signal/index.ts";
import { diagnosticsModule } from "./diagnostics/index.ts";
import { memoryModule } from "./memory/index.ts";
import { searchModule } from "./search/index.ts";
import { skillerModule } from "./skiller/index.ts";
import { skillsModule } from "./skills/index.ts";
import { verificationModule } from "./verification/index.ts";
import { workflowModule } from "./workflow/index.ts";
import type { ModuleDefinition } from "./types.ts";

export const BUILTIN_MODULES: readonly ModuleDefinition[] = [
  searchModule,
  verificationModule,
  commentSignalModule,
  skillsModule,
  skillerModule,
  workflowModule,
  diagnosticsModule,
  memoryModule,
];

export { isModuleEnabled, registerModules } from "./registry.ts";
export type { ModuleDefinition, ModuleRuntime } from "./types.ts";
