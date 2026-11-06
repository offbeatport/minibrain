import { createServer } from "vite";

const server = await createServer();
await server.listen();
server.printUrls();
server.bindCLIShortcuts({ print: true });

let stopping = false;
const stop = async () => {
    if (stopping) {
        return;
    }
    stopping = true;
    await server.close();
    process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
