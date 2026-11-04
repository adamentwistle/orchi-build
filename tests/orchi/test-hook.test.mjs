// The Orchi panel's test hook: steps a private Herdr can run with `herdr-app do orchi.script`, never the real window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { testing, scriptSteps } from "../../mods/orchi/test-hook.js";

test("only a private home counts", () => {
  assert.equal(testing("/Users/a/.config/hd/rec/"), true);
  assert.equal(testing("/Users/a/.config/herdr-app"), false);
  assert.equal(testing(undefined), false);
});

test("it keeps the steps it knows and drops the rest", () => {
  const steps = scriptSteps(JSON.stringify([
    { do: "option", value: "C" }, { do: "reply", text: "sunset first" }, { do: "send" },
    { do: "option", value: "rm -rf" }, { do: "option" }, { do: "reply", text: 7 }, { do: "kill" }, "x",
  ]));
  assert.deepEqual(steps, [{ do: "option", value: "C" }, { do: "reply", text: "sunset first" }, { do: "send" }]);
  assert.deepEqual(scriptSteps("not json"), []);
  assert.deepEqual(scriptSteps(JSON.stringify({ do: "send" })), []);
});
