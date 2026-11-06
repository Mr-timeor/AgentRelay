import { FileStore } from "../../dist/store/file-store.js";
import { initial, normalize } from "../../dist/core/model.js";

const [path, label] = process.argv.slice(2);
let store;
process.on("message", async ({ id, action, write = false }) => {
  try {
    if (action === "open") {
      store = await FileStore.open(path, initial(normalize({ agents: [], tasks: [{ id: "A1" }] })));
      if (write) await store.change(state => { state.progress.A1.summary = label; });
    } else if (action === "write") {
      await store.change(state => { state.progress.A1.summary = label; });
    } else if (action === "close") {
      await store?.close();
    } else throw new Error(`Unknown worker action: ${action}`);
    process.send({ id, ok: true, pid: process.pid, path: store?.path, state: store?.snapshot() });
  } catch (error) {
    process.send({ id, ok: false, error: String(error), pid: process.pid });
  }
});
process.send({ ready: true });
