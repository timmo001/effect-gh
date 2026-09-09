import { once } from "node:events";

switch (Bun.argv[2]) {
  case "inspect": {
    const stdin = await Bun.stdin.text();
    console.log(
      JSON.stringify({
        args: Bun.argv.slice(3),
        cwd: process.cwd(),
        token: Bun.env.GH_TOKEN,
        path: Bun.env.PATH,
        prompt: Bun.env.GH_PROMPT_DISABLED,
        pager: Bun.env.GH_PAGER,
        tty: Bun.env.GH_FORCE_TTY ?? null,
        stdin,
      }),
    );
    break;
  }
  case "pipes": {
    for (let i = 0; i < 32; i++) {
      if (!process.stdout.write("o".repeat(8192)))
        await once(process.stdout, "drain");
      if (!process.stderr.write("e".repeat(8192)))
        await once(process.stderr, "drain");
    }
    process.stderr.write("trailing error");
    process.stdout.write("trailing output");
    break;
  }
  case "wait": {
    setInterval(() => {}, 60_000);
    process.stdout.write("ready");
    break;
  }
}
