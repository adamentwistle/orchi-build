import { test } from "node:test";
import assert from "node:assert/strict";
import { testScript, testing, testTranscript } from "../../mods/claude-chat/test-hook.js";

test("only a private home counts as a test", () => {
  assert.equal(testing("/Users/a/.config/hd/s3"), true);
  assert.equal(testing("/Users/a/.config/herdr-app"), false);
});

test("the real window never reads the test file", async () => {
  let reads = 0;
  const read = async () => { reads++; return '{"transcript":"/x.jsonl"}'; };
  assert.equal(await testTranscript("/Users/a/.config/herdr-app", read), null);
  assert.equal(reads, 0);
  assert.equal(await testTranscript("/Users/a/.config/hd/s3", read), "/x.jsonl");
});

test("a missing or broken test file means no override", async () => {
  assert.equal(await testTranscript("/a/.config/hd/s3", async () => null), null);
  assert.equal(await testTranscript("/a/.config/hd/s3", async () => "{bad"), null);
});

test("the real window never reads a test script", async () => {
  let reads = 0;
  const read = async () => { reads++; return '[{"do":"send"}]'; };
  assert.deepEqual(await testScript("/Users/a/.config/herdr-app", read), []);
  assert.equal(reads, 0);
  assert.deepEqual(await testScript("/Users/a/.config/hd/s5", read), [{ do: "send" }]);
});

test("a missing or broken test script does nothing", async () => {
  assert.deepEqual(await testScript("/a/.config/hd/s5", async () => null), []);
  assert.deepEqual(await testScript("/a/.config/hd/s5", async () => "{bad"), []);
  assert.deepEqual(await testScript("/a/.config/hd/s5", async () => '{"do":"send"}'), []);
});
