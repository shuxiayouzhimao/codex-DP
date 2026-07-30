import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { countPetBridge, runInstall, withTempHome } from "../lib/install-test-helper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "install-hooks.mjs");

describe("cursor install-hooks", () => {
  it("install → 幂等 → uninstall", () => {
    withTempHome((home, env) => {
      const hooksPath = path.join(home, ".cursor", "hooks.json");

      let r = runInstall(SCRIPT, [], env);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.ok(fs.existsSync(hooksPath));
      let hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
      const n1 = countPetBridge(hooks);
      assert.ok(n1 >= 17, `期望至少 17 处 pet-bridge，实际 ${n1}`);

      r = runInstall(SCRIPT, [], env);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
      assert.equal(countPetBridge(hooks), n1);

      r = runInstall(SCRIPT, ["--uninstall"], env);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      if (fs.existsSync(hooksPath)) {
        hooks = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
        assert.equal(countPetBridge(hooks), 0);
      }
    });
  });
});
