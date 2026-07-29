import { mount } from "svelte";
import Config from "./Config.svelte";

const app = mount(Config, {
  target: document.getElementById("app")!,
});

export default app;
