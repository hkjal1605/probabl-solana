/** Check every active TypeScript workspace, then the standalone Solana scripts. */
const manifests = [...new Bun.Glob("{apps,packages,services}/*/package.json").scanSync(".")];
const results = await Promise.all(
  manifests.map(async (path) => {
    const manifest = await Bun.file(path).json();
    if (!manifest.scripts?.typecheck) return 0;
    console.info("Typecheck " + manifest.name);
    return Bun.spawn([process.execPath, "run", "typecheck"], {
      cwd: path.slice(0, -"/package.json".length),
      stdout: "inherit",
      stderr: "inherit",
    }).exited;
  }),
);
const scripts = await Bun.spawn(
  [process.execPath, "x", "--no-install", "tsc", "--noEmit", "-p", "scripts/solana/tsconfig.json"],
  { stdout: "inherit", stderr: "inherit" },
).exited;
if (scripts !== 0 || results.some((code) => code !== 0)) process.exit(1);
