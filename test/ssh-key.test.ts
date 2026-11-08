import { expect, test } from "bun:test";
import * as GpgKey from "../src/gpg-key.js";
import * as SshKey from "../src/ssh-key.js";
import { scriptedSpawner } from "./helpers.js";

test("ssh-key commands send key text on stdin and skip the delete prompt", async () => {
  const gh = scriptedSpawner([{ stdout: "" }, { stdout: "" }, { stdout: "" }]);

  await gh.run(
    SshKey.add({ key: "ssh-ed25519 AAAA", title: "laptop", type: "signing" }),
  );
  await gh.run(SshKey.add({ keyFile: "id.pub" }));
  await gh.run(SshKey.remove("123"));
  expect(gh.args()).toEqual([
    ["ssh-key", "add", "--title", "laptop", "--type", "signing", "-"],
    ["ssh-key", "add", "--", "id.pub"],
    ["ssh-key", "delete", "--yes", "--", "123"],
  ]);
  expect(gh.stdins[0]).toBe("ssh-ed25519 AAAA");
});

test("gpg-key commands send key text on stdin and list returns gh's text", async () => {
  const gh = scriptedSpawner([
    { stdout: "" },
    { stdout: "" },
    { stdout: "laptop\tABCD1234\n" },
  ]);

  await gh.run(GpgKey.add({ key: "-----BEGIN PGP-----", title: "work" }));
  await gh.run(GpgKey.remove("ABCD1234"));
  expect(await gh.run(GpgKey.list())).toBe("laptop\tABCD1234\n");
  expect(gh.args()).toEqual([
    ["gpg-key", "add", "--title", "work", "-"],
    ["gpg-key", "delete", "--yes", "--", "ABCD1234"],
    ["gpg-key", "list"],
  ]);
  expect(gh.stdins[0]).toBe("-----BEGIN PGP-----");
});
