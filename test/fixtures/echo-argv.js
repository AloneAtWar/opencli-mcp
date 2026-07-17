const args = process.argv.slice(2);
if (args[0] === "--fail") {
  process.stderr.write("fixture failure");
  process.exit(7);
}
process.stdout.write(JSON.stringify(args));
