// Verifies the subscription client against a fake Herdr socket.
//
// Run with `npm test`. Needs Node's built-in TypeScript stripping, which is why the
// package requires Node 22.19 or newer.
import net from "node:net";
import { unlinkSync } from "node:fs";

const SOCK = "/tmp/pi-subagent-test.sock";
process.env.HERDR_SOCKET_PATH = SOCK;
process.env.HERDR_ENV = "1";

const { herdrSubscribe, HerdrError } = await import("../herdr.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

async function withServer(onConn, fn) {
	try { unlinkSync(SOCK); } catch {}
	const connections = [];
	const server = net.createServer((s) => { connections.push(s); onConn(s, connections.length); });
	await new Promise((r) => server.listen(SOCK, r));
	try { await fn(connections); }
	finally { for (const c of connections) c.destroy(); await new Promise((r) => server.close(r)); }
}

const json = (o) => JSON.stringify(o) + "\n";

// --- 1. ack correlation: unrelated ids ignored, ack resets backoff, events delivered
console.log("\n1. ack correlation + event delivery");
await withServer(
	(s) => {
		let buf = "";
		s.on("data", (d) => {
			buf += d.toString();
			const line = buf.split("\n")[0];
			if (!line.trim()) return;
			buf = "";
			const req = JSON.parse(line);
			// An error tagged with someone else's id must be ignored by the client.
			s.write(json({ id: "someone-else", error: { code: "nope", message: "ignore me" } }));
			s.write(json({ id: req.id, result: { type: "subscription_started" } }));
			s.write(json({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "working" } }));
			s.write(json({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "blocked" } }));
		});
	},
	async () => {
		const events = [];
		const errors = [];
		const dispose = herdrSubscribe(() => [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }],
			(e) => events.push(e), (err) => errors.push(err));
		await sleep(300);
		dispose();
		check("events delivered", events.length === 2, `got ${events.length}`);
		check("blocked event carried", events[1]?.data?.agent_status === "blocked");
		check("foreign-id error ignored", errors.length === 0, `errors=${errors.length}`);
	},
);

// --- 2. a rejected subscription is reported, not silently dropped
console.log("\n2. rejected subscription surfaces an error");
await withServer(
	(s) => {
		let buf = "";
		s.on("data", (d) => {
			buf += d.toString();
			const line = buf.split("\n")[0];
			if (!line.trim()) return;
			buf = "";
			const req = JSON.parse(line);
			s.write(json({ id: req.id, error: { code: "bad_subscription", message: "unknown subscription type" } }));
		});
	},
	async () => {
		const errors = [];
		const dispose = herdrSubscribe(() => [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }],
			() => {}, (err) => errors.push(err));
		await sleep(300);
		dispose();
		check("error reported", errors.length >= 1, `got ${errors.length}`);
		check("error is a HerdrError with the server code",
			errors[0] instanceof HerdrError && errors[0].code === "bad_subscription",
			`${errors[0]?.name}:${errors[0]?.code}`);
	},
);

// --- 3. a throwing consumer is contained rather than crashing the host
console.log("\n3. throwing onEvent is contained");
await withServer(
	(s) => {
		let buf = "";
		s.on("data", (d) => {
			buf += d.toString();
			const line = buf.split("\n")[0];
			if (!line.trim()) return;
			buf = "";
			const req = JSON.parse(line);
			s.write(json({ id: req.id, result: { type: "subscription_started" } }));
			s.write(json({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "working" } }));
			s.write(json({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "done" } }));
		});
	},
	async () => {
		const errors = [];
		let calls = 0;
		const dispose = herdrSubscribe(() => [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }],
			() => { calls++; throw new Error("widget exploded"); },
			(err) => errors.push(err));
		await sleep(300);
		dispose();
		check("process survived the throw", true);
		check("both events still dispatched", calls === 2, `got ${calls}`);
		check("throw reported through onError", errors.some((e) => e.message === "widget exploded"));
	},
);

// --- 4. disposing from inside a handler stops further dispatch
console.log("\n4. disposal from inside onEvent stops dispatch");
await withServer(
	(s) => {
		let buf = "";
		s.on("data", (d) => {
			buf += d.toString();
			if (!buf.includes("\n")) return;
			const req = JSON.parse(buf.split("\n")[0]);
			buf = "";
			s.write(json({ id: req.id, result: { type: "subscription_started" } }));
			// All three land in one TCP write, so the reentrancy guard is what stops them.
			s.write(
				json({ event: "pane.agent_status_changed", data: { n: 1 } }) +
				json({ event: "pane.agent_status_changed", data: { n: 2 } }) +
				json({ event: "pane.agent_status_changed", data: { n: 3 } }),
			);
		});
	},
	async () => {
		let calls = 0;
		let dispose;
		dispose = herdrSubscribe(() => [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }],
			() => { calls++; dispose(); });
		await sleep(300);
		check("only the first buffered event was dispatched", calls === 1, `got ${calls}`);
	},
);

// --- 5. a throwing subscriptions() factory is reported and still retried
console.log("\n5. subscriptions() throwing does not strand the client");
await withServer(
	(s) => {
		let buf = "";
		s.on("data", (d) => {
			buf += d.toString();
			if (!buf.includes("\n")) return;
			const req = JSON.parse(buf.split("\n")[0]);
			buf = "";
			s.write(json({ id: req.id, result: { type: "subscription_started" } }));
		});
	},
	async (connections) => {
		const errors = [];
		let attempts = 0;
		const dispose = herdrSubscribe(
			() => {
				attempts++;
				if (attempts === 1) throw new Error("manifest read failed");
				return [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }];
			},
			() => {},
			(err) => errors.push(err),
		);
		await sleep(2500);
		dispose();
		check("factory throw reported", errors.some((e) => e.message === "manifest read failed"));
		check("reconnected and subscribed on a later attempt", attempts >= 2, `attempts=${attempts}`);
		check("a second connection was made", connections.length >= 2, `connections=${connections.length}`);
	},
);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
