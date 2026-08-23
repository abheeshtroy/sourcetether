import { createDefaultMissionApiDependencies, createMissionApiServer } from "../dist/src/mission-api.js";

const port = Number(process.env.PORT ?? "8787");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write("PORT must be an integer from 1 through 65535.\n");
  process.exitCode = 1;
} else {
  const server = createMissionApiServer(createDefaultMissionApiDependencies());
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`SourceTether API listening at http://127.0.0.1:${port}\n`);
  });
}
