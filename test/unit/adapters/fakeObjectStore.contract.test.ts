import { FakeObjectStore } from "../../support/fakeObjectStore.js";
import { objectStoreContract } from "../../support/objectStoreContract.js";

objectStoreContract("FakeObjectStore", () => Promise.resolve({ store: new FakeObjectStore() }));
