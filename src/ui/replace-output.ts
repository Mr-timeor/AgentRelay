import { rename } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const delays = [20, 40, 80, 160, 320];
const transient = new Set(["EPERM", "EACCES", "EBUSY"]);

// Previewers can briefly hold the destination on Windows. Keep the previous
// complete HTML until one atomic replacement succeeds; never delete it first.
export async function replaceOutput(source: string, target: string, operations: {
  rename: (source: string, target: string) => Promise<void>;
  sleep: (milliseconds: number) => Promise<unknown>;
} = { rename, sleep }): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await operations.rename(source, target); return; }
    catch (error: any) {
      if (!transient.has(error.code) || attempt >= delays.length) throw error;
      await operations.sleep(delays[attempt]);
    }
  }
}
