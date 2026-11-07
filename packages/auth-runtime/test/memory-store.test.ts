import { createMemoryStore } from "../src/stores/memory.ts";
import { describeStoreContract } from "./store-contract.ts";

// UNIT: the in-memory store is for tests, development and one process.
describeStoreContract("unit: memory store", async () => createMemoryStore());
