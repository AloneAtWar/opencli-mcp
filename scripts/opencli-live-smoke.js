import { createOpenCliRunner, resolveOpenCli } from "../src/opencli-runner.js";

const resolved = resolveOpenCli();
const run = createOpenCliRunner({ resolved });
const version = await run(["--version"], { timeoutMs: 30_000 });
const doctor = await run(["doctor"], { timeoutMs: 120_000 });
console.log(JSON.stringify({
  resolved,
  version: version.data,
  doctor: doctor.data,
  doctorStderr: doctor.stderr,
}, null, 2));
