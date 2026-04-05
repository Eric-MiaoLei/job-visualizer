import { config } from "../config.js";
import { FileJobStore } from "./fileStore.js";
import { MongoJobStore } from "./mongoStore.js";

export async function createStore() {
  const store =
    config.storeMode === "mongo"
      ? new MongoJobStore(config.mongodbUri)
      : new FileJobStore();

  await store.init();
  return store;
}
