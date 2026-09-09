/** Disposable, stateful GitHub fixture for protocol and cross-process acceptance. Never production. */
import { loadConfig } from "./config.ts";
import { loadDispatchConfig } from "./dispatch/config.ts";
import { QueueController } from "./dispatch/controller.ts";
import { DispatchStore } from "./dispatch/store.ts";
import { WarrenClient } from "./dispatch/warren.ts";
import { FakeGitHub } from "./fake-github.ts";
import { GitHubClient } from "./github/client.ts";
import { createHandler } from "./server.ts";

const config = loadConfig({
	GITHUB_TOKEN: "fixture-token",
	GITHUB_REPOSITORY: "acme/web",
	GITHUB_ALLOW_CLOSE: "true",
});
const fake = new FakeGitHub();
const client = new GitHubClient(config, fake.fetch);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createHandler(config, client) });
console.log(JSON.stringify({ port: server.port }));
const dispatch = loadDispatchConfig(process.env);
if (dispatch) {
	const store = new DispatchStore(dispatch.database);
	try {
		await new QueueController(dispatch, client, new WarrenClient(dispatch), store).tick();
	} finally {
		store.close();
		server.stop(true);
	}
}
