import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { countPetBridge, runInstall, withTempHome } from "../lib/install-test-helper.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "install-hooks.mjs");

describe("claude-code install-hooks", () => {
  it("install → 幂等 → uninstall", () => {
    withTempHome((home, env) => {
      const settingsPath = path.join(home, ".claude", "settings.json");

      let r = runInstall(SCRIPT, [], env);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      assert.ok(fs.existsSync(settingsPath));
      let settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const n1 = countPetBridge(settings);
      assert.ok(n1 >= 15, `期望至少 15 处 pet-bridge，实际 ${n1}`);

      // 幂等：再装不应翻倍
      r = runInstall(SCRIPT, [], env);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      assert.equal(countPetBridge(settings), n1);

      r = runInstall(SCRIPT, ["--uninstall"], env);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      assert.equal(countPetBridge(settings), 0);
    });
  });
});
